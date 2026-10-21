// Brings a task's branch up to origin's current default branch before a
// fix round runs (issue #235). Host-side, git only, never in a worker:
// a worker's git mounts are read-only by design (src/containment), so it
// could not commit a rebase even if it were asked to, and rewriting a
// branch's history is not a judgement call to hand a model.
//
// This lives next to cut.ts on purpose. `fetchOriginDefaultBranch` is
// already the one place that answers "which branch does a task's base
// commit come from", and this module asks it the same question for the
// same reason - deriving it twice is how the two sides come to disagree
// about what a task is forked from. It also inherits src/line's standing
// rule: never act on a path without first proving, through git itself,
// that it is the exact throwaway worktree expected and not a live
// checkout. That matters more here than anywhere else in this module -
// `git rebase` rewrites commits, so a wrong path is not a lost file but
// a lost history.
//
// A conflict is a RESULT here, not a LineError: it leaves the rebase
// stopped in the worktree with the markers in place, and the caller
// (src/foreman/fix-rebase.ts) decides what happens next - hand it to the
// round's worker to resolve, or abort and report. Only a rebase that
// failed for some other reason throws.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { LineError } from "./errors.ts";
import type { ProductionLine } from "../../contract/surface.ts";
import { describeGitError, requireLinkedWorktree } from "./safety.ts";
import { fetchOriginDefaultBranch } from "./cut.ts";

/** Config forced onto every history-writing git call here, for the same
 * reasons src/foreman/commit.ts forces its own: a throwaway worktree has
 * no claim on the Client's git identity or signing key, and a project
 * hook that wants installed dependencies would abort the rebase. Two more
 * are specific to rebasing:
 *
 * - `rebase.autoStash=false` - a Client who turned autostash on in his own
 *   config must not have it silently stash a worker's uncommitted work
 *   into a stash entry nothing here ever reads back.
 * - `rerere.enabled=false` - rerere would resolve a conflict from the
 *   Client's own recorded resolutions, so a conflict he was never shown
 *   could be applied on his behalf. The whole point of this module's
 *   conflict path is that he sees the markers and rules on them. */
const FORCED_CONFIG = [
  "-c",
  "user.name=Fabrica",
  "-c",
  "user.email=fabrica@local",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "rebase.autoStash=false",
  "-c",
  "rerere.enabled=false",
];

/** No rebase step here is interactive; a git that nonetheless reaches for
 * an editor (a `merge.tool`, a `core.editor` wrapper) would hang the
 * detached worker process forever instead of failing. */
const NON_INTERACTIVE_ENV = { ...process.env, GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" };

/** How many lines of conflict markers one file contributes to a report
 * (Client ruling: "every conflicted file with its full marker hunks,
 * capped at 200 lines per file and 2000 total, saying so when cut"). */
export const MAX_CONFLICT_LINES_PER_FILE = 200;
/** How many lines of conflict markers a whole report carries. */
export const MAX_CONFLICT_LINES_TOTAL = 2000;

/** A file big enough that reading it whole to find markers is itself the
 * problem. Named in the report instead of read. */
const MAX_CONFLICT_FILE_BYTES = 8 * 1024 * 1024;

/** A conflicted rebase, as much of it as a report carries. */
export interface RebaseConflict {
  /** Every conflicted path git named, worktree-relative, in git's order. */
  files: string[];
  /** Those files' conflict marker hunks, rendered for a human to read,
   * within the caps above. */
  markers: string;
  /** True when a cap left something out of `markers` - the rendering
   * says so in place, this is for a caller that wants to know. */
  truncated: boolean;
}

export interface RebaseOutcome {
  /** "already-current": the branch already contains origin's tip, so
   * nothing was rebased. "rebased": origin's tip is now the branch's
   * fork point. "conflicted": the rebase is still in progress in the
   * worktree, stopped on the conflict in `conflict`, with the markers in
   * the working tree - it is the caller's to finish or abort. */
  status: "already-current" | "rebased" | "conflicted";
  /** origin's default branch name, e.g. "main" - never assumed. */
  base: string;
  /** The commit `origin/<base>` pointed at when this ran. After
   * "rebased", this is the branch's new fork point and what a delivery's
   * `files` diff must be pinned to. */
  baseCommit: string;
  /** Set exactly when `status` is "conflicted". */
  conflict?: RebaseConflict;
  /** The branch's two tips as they stood the moment before this ran -
   * read after the fetch above, which is the only moment both are true
   * at once. What a later publish leases against (inspector#53). */
  tips: BranchTips;
}

/** A task branch's own last commit and origin's copy of it, as of one
 * moment. Either can be null, and neither being readable is ever a
 * failure: a caller asking these questions is deciding whether it can
 * add a safety flag, not whether it can carry on. */
export interface BranchTips {
  /** `refs/heads/<branch>`, or null when it cannot be read. */
  branch: string | null;
  /** `refs/remotes/origin/<branch>`, or null when origin has no copy of
   * this branch - a task branch nothing has ever published. */
  remote: string | null;
}

/** What `finishRebase` found. "conflicted" carries why: the worker left
 * markers behind, or a later commit of the same rebase conflicted on its
 * own and no worker has ever seen it. */
export type FinishOutcome =
  | { status: "completed" }
  | { status: "conflicted"; reason: "markers-remain" | "new-conflict"; conflict: RebaseConflict };

function git(workdir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: workdir,
    encoding: "utf8",
    env: NON_INTERACTIVE_ENV,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Runs a git command and says only whether it succeeded - for the
 * questions git answers with an exit status (`--is-ancestor`,
 * `--quiet` diffs) and for the rebase steps whose failure is a result
 * rather than an error. */
function gitOk(workdir: string, args: string[]): { ok: true } | { ok: false; error: unknown } {
  try {
    git(workdir, args);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/** The commit `rev` names in `dir`, or null when there is no such ref.
 * Never throws: every caller here is asking a question whose unknown
 * answer is "then assume nothing", never "then fail". */
function commitAt(dir: string, rev: string): string | null {
  try {
    const commit = git(dir, ["rev-parse", "--verify", rev]).trim();
    return commit.length > 0 ? commit : null;
  } catch {
    return null;
  }
}

/** The branch's own last commit right now, or null when it cannot be
 * read. Asked after a rebase to answer "did it actually move the
 * branch" against the `tips.branch` read before it. */
export function branchTip(line: ProductionLine): string | null {
  return commitAt(line.project, `refs/heads/${line.branch}`);
}

/** The rebase state directory git itself names for this worktree, if one
 * exists. Resolved through `git rev-parse --git-path` rather than assumed
 * to be `<workdir>/.git/rebase-merge`: a ProductionLine is a *linked*
 * worktree, so its per-worktree git dir lives under the project's own
 * `.git/worktrees/<name>/`, nowhere near the workdir. Never throws - a
 * workdir already destroyed simply has no rebase in progress. */
function rebaseStateDir(workdir: string): string | null {
  for (const name of ["rebase-merge", "rebase-apply"]) {
    try {
      const path = git(workdir, ["rev-parse", "--git-path", name]).trim();
      const absolute = isAbsolute(path) ? path : join(workdir, path);
      if (existsSync(absolute)) return absolute;
    } catch {
      return null;
    }
  }
  return null;
}

/** True while a rebase is stopped mid-flight in `workdir`. Never throws. */
export function rebaseInProgress(workdir: string): boolean {
  return rebaseStateDir(workdir) !== null;
}

/** Back to the pre-rebase commit, discarding whatever the stopped rebase
 * had applied. Tolerant of there being no rebase to abort (the caller's
 * teardown path calls this defensively), but never silent about a git
 * that refused for some other reason. */
export function abortRebase(workdir: string): void {
  if (!rebaseInProgress(workdir)) return;
  const result = gitOk(workdir, [...FORCED_CONFIG, "rebase", "--abort"]);
  if (!result.ok) {
    throw new LineError(
      "rebase-failed",
      `Could not abort the stopped rebase in ${workdir}: ${describeGitError(result.error)}`
    );
  }
}

/** Paths git currently reports as unmerged, worktree-relative. */
function conflictedFiles(workdir: string): string[] {
  return git(workdir, ["diff", "--name-only", "--diff-filter=U", "-z"])
    .split("\0")
    .filter((path) => path.length > 0);
}

const MARKER_START = /^<{7}(?: |$)/;
const MARKER_END = /^>{7}(?: |$)/;

/**
 * Every line that is a conflict marker's own opening or closing line,
 * with its 1-based line number - the question "is this file still
 * unresolved" in full, whether or not the markers still form whole hunks.
 * A worker that deleted one marker line and left the other has not
 * resolved anything, and that must not reach the branch.
 *
 * `=======` on its own is deliberately NOT a marker here. Git only ever
 * writes it between the other two, while a row of exactly seven "=" is
 * ordinary content - a markdown heading underline, a rule in a comment -
 * so counting it would call genuinely resolved files unresolved, which
 * costs the Client a round for nothing.
 */
function markerLines(content: string): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = [];
  content.split("\n").forEach((text, index) => {
    if (MARKER_START.test(text) || MARKER_END.test(text)) found.push({ line: index + 1, text });
  });
  return found;
}

/** Every `<<<<<<< … >>>>>>>` hunk in `content`, in order, as line arrays. */
function markerHunks(content: string): string[][] {
  const hunks: string[][] = [];
  let current: string[] | null = null;
  for (const line of content.split("\n")) {
    if (current === null) {
      if (MARKER_START.test(line)) current = [line];
      continue;
    }
    current.push(line);
    if (MARKER_END.test(line)) {
      hunks.push(current);
      current = null;
    }
  }
  // An unterminated hunk is still worth showing - it is exactly the shape
  // a half-resolved file has, and the Client is the one judging it.
  if (current !== null) hunks.push(current);
  return hunks;
}

/** True when `path`'s content still carries a conflict marker. A file git
 * no longer calls unmerged can still hold markers - that is precisely the
 * "the worker staged its own half-resolution" case this exists to catch. */
function hasMarkers(workdir: string, path: string): boolean {
  const read = readConflictFile(workdir, path);
  return read.kind === "text" && markerLines(read.content).length > 0;
}

type ConflictFileRead =
  | { kind: "text"; content: string }
  | { kind: "unreadable"; why: string };

function readConflictFile(workdir: string, path: string): ConflictFileRead {
  const absolute = join(workdir, path);
  let size: number;
  try {
    size = statSync(absolute).size;
  } catch {
    // A delete/delete or rename/delete conflict leaves no file in the
    // worktree at all; there is nothing to show, and saying so beats
    // showing nothing.
    return { kind: "unreadable", why: "no file in the working tree (a delete conflict)" };
  }
  if (size > MAX_CONFLICT_FILE_BYTES) {
    return { kind: "unreadable", why: `${size} bytes - too large to quote` };
  }
  let raw: Buffer;
  try {
    raw = readFileSync(absolute);
  } catch (err) {
    return { kind: "unreadable", why: err instanceof Error ? err.message : String(err) };
  }
  if (raw.includes(0)) return { kind: "unreadable", why: "binary file - it carries no text conflict markers" };
  return { kind: "text", content: raw.toString("utf8") };
}

/** The conflict a report carries: every conflicted file with its marker
 * hunks, capped per file and in total, and saying so wherever a cap cut
 * something. Nothing here is inferred - the file list is git's own, and
 * the hunks are read straight out of the working tree. */
export function describeConflict(workdir: string, files: string[]): RebaseConflict {
  const sections: string[] = [];
  let totalLines = 0;
  let truncated = false;
  let filesLeftOut = 0;

  for (const path of files) {
    if (totalLines >= MAX_CONFLICT_LINES_TOTAL) {
      filesLeftOut += 1;
      truncated = true;
      continue;
    }

    const read = readConflictFile(workdir, path);
    if (read.kind === "unreadable") {
      sections.push(`--- ${path}\n[${read.why}]`);
      continue;
    }

    const hunks = markerHunks(read.content);
    if (hunks.length === 0) {
      // No whole hunk left, but possibly a marker line on its own - a
      // half-deleted marker is still an unresolved file, and quoting the
      // lines with their numbers is the only useful thing to show.
      const stray = markerLines(read.content);
      sections.push(
        stray.length === 0
          ? `--- ${path}\n[no conflict markers in the working tree copy]`
          : [
              `--- ${path} (${stray.length} stray marker line${stray.length === 1 ? "" : "s"}, no whole hunk)`,
              ...stray.slice(0, MAX_CONFLICT_LINES_PER_FILE).map(({ line, text }) => `${line}: ${text}`),
            ].join("\n")
      );
      if (stray.length > 0) totalLines += Math.min(stray.length, MAX_CONFLICT_LINES_PER_FILE);
      continue;
    }

    const lines = hunks.flat();
    const perFileRoom = Math.min(MAX_CONFLICT_LINES_PER_FILE, MAX_CONFLICT_LINES_TOTAL - totalLines);
    const kept = lines.slice(0, perFileRoom);
    totalLines += kept.length;

    const header = `--- ${path} (${hunks.length} conflict hunk${hunks.length === 1 ? "" : "s"})`;
    const cut =
      kept.length < lines.length
        ? [
            `[cut: ${lines.length - kept.length} of ${lines.length} marker lines in ${path} not shown ` +
              `(cap: ${MAX_CONFLICT_LINES_PER_FILE} lines per file, ${MAX_CONFLICT_LINES_TOTAL} in total)]`,
          ]
        : [];
    if (cut.length > 0) truncated = true;
    sections.push([header, ...kept, ...cut].join("\n"));
  }

  if (filesLeftOut > 0) {
    sections.push(
      `[cut: ${filesLeftOut} more conflicted file${filesLeftOut === 1 ? "" : "s"} not shown - the report ` +
        `reached its ${MAX_CONFLICT_LINES_TOTAL}-line total cap]`
    );
  }

  return { files, markers: sections.join("\n\n"), truncated };
}

/** Proof, from git itself, that `line.workdir` is this line's own
 * throwaway worktree checked out on this line's own branch - run before
 * any command that rewrites history. `requireLinkedWorktree` already
 * refuses the Client's own checkout and any path git does not register as
 * a linked worktree of the project; the branch check is the second half:
 * a worktree sitting at a detached HEAD, or on some other branch, is not
 * the thing this rebase was asked to move. */
function requireRebasableLine(line: ProductionLine): void {
  const entry = requireLinkedWorktree(line.project, line.workdir);
  if (entry.branch !== line.branch) {
    throw new LineError(
      "unsafe-rebase",
      `Refusing to rebase ${line.workdir}: git has it checked out on ` +
        `${entry.branch === null ? "a detached HEAD" : `"${entry.branch}"`}, not "${line.branch}".`
    );
  }
}

/**
 * Rebases `line`'s branch onto origin's current default branch, in
 * `line`'s own worktree, with git and nothing else.
 *
 * Skipped entirely when the branch already contains origin's tip (Client
 * ruling: "before every fix round, skipped when the branch already
 * contains origin's default tip") - there is nothing to replay, and
 * rewriting the branch's commits for no gain would change every sha a
 * reviewer has already looked at.
 *
 * A conflict leaves the rebase STOPPED, with the markers in the working
 * tree: that is the one state both of its callers' next steps need - the
 * round's own worker resolves the markers in place and `finishRebase`
 * continues, or `abortRebase` puts the branch back. Nothing here decides
 * between those (see src/foreman/fix-rebase.ts).
 */
export function rebaseOntoOriginDefault(line: ProductionLine): RebaseOutcome {
  requireRebasableLine(line);
  if (rebaseInProgress(line.workdir)) {
    throw new LineError(
      "unsafe-rebase",
      `Refusing to rebase ${line.workdir}: a rebase is already in progress there. ` +
        `Finish or abort it before starting another.`
    );
  }

  const base = fetchOriginDefaultBranch(line.project);
  let baseCommit: string;
  try {
    baseCommit = git(line.project, ["rev-parse", "--verify", `refs/remotes/origin/${base}`]).trim();
  } catch (err) {
    throw new LineError(
      "fetch-failed",
      `Could not read origin/${base} for ${line.project} after fetching: ${describeGitError(err)}. ` +
        `Refusing to rebase the task's branch against a base nobody can name.`
    );
  }

  // Read here, between the fetch and the rebase: the remote tip is only
  // the one `--force-with-lease` will compare against if it is the one
  // the fetch just brought in, and the branch tip is only a "before" if
  // nothing has rewritten it yet.
  const tips: BranchTips = {
    branch: branchTip(line),
    remote: commitAt(line.project, `refs/remotes/origin/${line.branch}`),
  };

  // Already contains origin's tip: nothing to do, and nothing rewritten.
  if (gitOk(line.workdir, ["merge-base", "--is-ancestor", baseCommit, "HEAD"]).ok) {
    return { status: "already-current", base, baseCommit, tips };
  }

  const rebase = gitOk(line.workdir, [...FORCED_CONFIG, "rebase", baseCommit]);
  if (rebase.ok) return { status: "rebased", base, baseCommit, tips };

  // A failed rebase is a conflict only if git actually stopped on one.
  // Anything else (a locked index, an unreadable object) is a real error
  // and must not be dressed up as something the Client can rule on.
  const stopped = rebaseInProgress(line.workdir);
  const files = stopped ? conflictedFiles(line.workdir) : [];
  if (!stopped || files.length === 0) {
    if (stopped) abortRebase(line.workdir);
    throw new LineError(
      "rebase-failed",
      `Could not rebase ${line.branch} onto origin/${base} in ${line.workdir}: ${describeGitError(rebase.error)}`
    );
  }

  return { status: "conflicted", base, baseCommit, tips, conflict: describeConflict(line.workdir, files) };
}

/** True when the index holds nothing the next commit could record - so
 * `git rebase --continue` would refuse with "no changes" and `--skip` is
 * the right step instead. Asked of the index directly rather than
 * inferred from git's own wording, which is not a stable interface. */
function indexMatchesHead(workdir: string): boolean {
  return gitOk(workdir, ["diff", "--cached", "--quiet", "HEAD"]).ok;
}

/** A rebase replays a bounded number of commits; this only exists so a
 * git that somehow never finishes cannot spin the host forever. */
const MAX_REBASE_STEPS = 1000;

/**
 * Finishes a rebase that was left stopped: stages everything in the
 * working tree and continues, commit by commit, until the rebase is done.
 * The staging is deliberately the host's job - a worker's git is
 * read-only, so it can resolve the markers in the files and nothing more.
 *
 * Refuses to stage anything while a conflict marker is still in the
 * working tree: committing `<<<<<<<` onto the branch would hand Inspector
 * (and the Client) something strictly worse than an honest report that
 * the conflict is unresolved. A later commit of the same rebase can also
 * conflict on its own, which no worker has been shown yet; that comes
 * back as "new-conflict". Either way the caller aborts and reports.
 */
export function finishRebase(workdir: string): FinishOutcome {
  if (!rebaseInProgress(workdir)) return { status: "completed" };

  const started = conflictedFiles(workdir);
  const unresolved = started.filter((path) => hasMarkers(workdir, path));
  if (unresolved.length > 0) {
    return { status: "conflicted", reason: "markers-remain", conflict: describeConflict(workdir, unresolved) };
  }

  for (let step = 0; step < MAX_REBASE_STEPS; step++) {
    if (!rebaseInProgress(workdir)) return { status: "completed" };

    const staged = gitOk(workdir, ["add", "-A"]);
    if (!staged.ok) {
      throw new LineError(
        "rebase-failed",
        `Could not stage the resolved conflict in ${workdir}: ${describeGitError(staged.error)}`
      );
    }

    // An empty result is a legitimate resolution ("take the upstream side
    // wholesale"), and `--continue` refuses it; `--skip` drops the now
    // redundant commit and moves on, which is the same end state.
    const next = indexMatchesHead(workdir) ? "--skip" : "--continue";
    const advanced = gitOk(workdir, [...FORCED_CONFIG, "rebase", next]);
    if (advanced.ok) continue;

    const files = rebaseInProgress(workdir) ? conflictedFiles(workdir) : [];
    if (files.length > 0) {
      return { status: "conflicted", reason: "new-conflict", conflict: describeConflict(workdir, files) };
    }
    throw new LineError(
      "rebase-failed",
      `Could not continue the rebase in ${workdir}: ${describeGitError(advanced.error)}`
    );
  }

  throw new LineError(
    "rebase-failed",
    `The rebase in ${workdir} did not finish after ${MAX_REBASE_STEPS} steps; it is still in progress.`
  );
}
