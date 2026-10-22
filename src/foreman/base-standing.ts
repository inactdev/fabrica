// Where a delivered task's branch stands against origin's default branch
// - the one fact a Client ruling on a delivery cannot see anywhere else:
// the branch was cut from origin's tip (src/line/cut.ts), but origin
// moves while the task works, and a branch that no longer contains that
// tip is one a `fix` would rebase before anything else happened (issue
// #235's existing fix-round rebase). `fabrica status` and the live view
// both mark it from here, so the two can never word it differently.
//
// LABEL ONLY, and it writes nothing. Nothing in this file rebases
// anything, and every git call below is a read:
//
//  - `git symbolic-ref --short refs/remotes/origin/HEAD` - which branch
//    origin calls default, read from the local symref rather than from
//    the remote. `src/line/cut.ts` asks the same question over the
//    network (`git ls-remote --symref origin HEAD`) because it is about
//    to cut a branch from the answer; this is a report, and a report must
//    not fetch. Verified on git 2.54.0: `git clone` writes that symref,
//    and `git fetch origin` writes it when it is missing - and Fabrica
//    fetches at both moments that matter (cutting a line, and before
//    every fix round), so in practice it is there and current. Never
//    assumed to be "master": when it genuinely is not set, this says
//    "base unknown" and why.
//  - `git rev-parse --verify` on the two refs, and
//    `git merge-base --is-ancestor` between them.
//  - `stat` on whatever path `git rev-parse --git-path FETCH_HEAD`
//    names, for the one caveat this reading needs: it is only as fresh
//    as the last fetch, so the label says how long ago that was.
//
// A question this cannot answer is never answered anyway: there is no
// silent fall back to "current" (Client ruling) - a missing origin, an
// unset origin/HEAD, a deleted branch or a moved project all come back as
// `{ status: "unknown", reason }` and show as "base unknown: <reason>".

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { formatAge } from "./age.ts";

export type BaseStanding =
  /** The branch contains origin's default tip - nothing to say. */
  | { status: "current"; base: string; fetchedAgoMs: number | null }
  /** origin's default tip is not in the branch's history: a `fix` round
   * would rebase onto it before any worker ran. */
  | { status: "behind"; base: string; fetchedAgoMs: number | null }
  /** The check could not produce an answer. `reason` is one line, shown
   * verbatim to the Client. */
  | { status: "unknown"; reason: string };

/** A reason is a single line on a status listing, so git's own stderr -
 * which can run to several lines - is cut down to its first and capped. */
const REASON_MAX_LENGTH = 200;

function oneLine(text: string): string {
  const first = text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
  return first.length > REASON_MAX_LENGTH ? `${first.slice(0, REASON_MAX_LENGTH)}…` : first;
}

type GitResult = { ok: true; out: string } | { ok: false; status: number | null; message: string };

/** One read-only git call in `project`. Never throws: every failure is a
 * reason to report rather than an exception to raise, since this whole
 * module is a report. */
function git(project: string, args: string[]): GitResult {
  try {
    const out = execFileSync("git", args, {
      cwd: project,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out: out.trim() };
  } catch (err) {
    const error = err as { status?: number | null; stderr?: Buffer | string; message?: string };
    const stderr = error.stderr?.toString() ?? "";
    return {
      ok: false,
      status: typeof error.status === "number" ? error.status : null,
      message: oneLine(stderr.trim().length > 0 ? stderr : (error.message ?? String(err))),
    };
  }
}

/** How long ago this checkout last fetched, from the mtime of the file
 * git itself writes on every fetch (verified on git 2.54.0: `FETCH_HEAD`
 * is rewritten even when the fetch brought nothing new). Null when there
 * is no such file - a checkout that has never fetched, or one whose
 * fetches ran somewhere else - in which case the label simply omits the
 * freshness clause rather than inventing one.
 *
 * The path is asked of git, never assumed to be `<project>/.git/
 * FETCH_HEAD`: in a linked worktree it is the per-worktree git dir's own
 * copy, and `src/line`'s fetches all run in the project's main checkout. */
function lastFetchAgoMs(project: string, now: number): number | null {
  const path = git(project, ["rev-parse", "--git-path", "FETCH_HEAD"]);
  if (!path.ok || path.out.length === 0) return null;
  try {
    const absolute = isAbsolute(path.out) ? path.out : join(project, path.out);
    return Math.max(0, now - statSync(absolute).mtimeMs);
  } catch {
    return null;
  }
}

/**
 * Whether `branch` in `project` still contains origin's default tip, read
 * from local refs alone.
 *
 * `project`/`branch` are nullable because the callers read them off the
 * record (whichever event last carried `details.project`, and the
 * delivery's own `branch`), and a task whose record names neither is
 * exactly the "cannot answer" case this returns a reason for - deciding
 * that here keeps every reason's wording in one place.
 */
export function baseStandingOf(project: string | null, branch: string | null, now: number = Date.now()): BaseStanding {
  if (project === null || project.trim().length === 0) {
    return { status: "unknown", reason: "no project recorded for this task" };
  }
  if (branch === null || branch.trim().length === 0) {
    return { status: "unknown", reason: "no branch recorded on the delivery" };
  }
  // Checked before git rather than after: with a cwd that isn't there,
  // every call below fails as "spawnSync git ENOENT", which names node's
  // own plumbing instead of the one thing that is actually wrong.
  if (!existsSync(project)) {
    return { status: "unknown", reason: `the project folder ${project} is not there any more` };
  }

  // Full ref paths everywhere below, never bare names: it removes any
  // ambiguity between a branch and a tag of the same name, and no
  // argument can start with "-" however odd the recorded branch is.
  const head = git(project, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (!head.ok) return { status: "unknown", reason: describeMissingOriginHead(project, head.message) };

  // "origin/main" -> "main". symbolic-ref --short shortens to the
  // remote-tracking form; the label names the branch as the Client knows
  // it, "origin/main".
  const base = head.out.replace(/^origin\//, "");
  if (base.length === 0) {
    return { status: "unknown", reason: `origin/HEAD names "${head.out}", which is not a branch of origin` };
  }

  const baseRef = `refs/remotes/origin/${base}`;
  const baseCommit = git(project, ["rev-parse", "--verify", "--quiet", baseRef]);
  if (!baseCommit.ok || baseCommit.out.length === 0) {
    return {
      status: "unknown",
      reason: `origin/${base} is not in this checkout - origin/HEAD points at a branch nothing has fetched`,
    };
  }

  const branchRef = `refs/heads/${branch}`;
  const branchCommit = git(project, ["rev-parse", "--verify", "--quiet", branchRef]);
  if (!branchCommit.ok || branchCommit.out.length === 0) {
    return { status: "unknown", reason: `the branch ${branch} is gone from ${project}` };
  }

  // `--is-ancestor` answers with its exit status: 0 contains, 1 behind.
  // Anything else is a real failure and must not read as "behind".
  const contains = git(project, ["merge-base", "--is-ancestor", baseRef, branchRef]);
  if (!contains.ok && contains.status !== 1) {
    return { status: "unknown", reason: `git could not compare ${branch} with origin/${base}: ${contains.message}` };
  }

  const fetchedAgoMs = lastFetchAgoMs(project, now);
  return contains.ok ? { status: "current", base, fetchedAgoMs } : { status: "behind", base, fetchedAgoMs };
}

/** Why `refs/remotes/origin/HEAD` could not be read - told apart, with
 * two more local reads, so the Client is pointed at the actual fix
 * instead of one sentence covering three different situations. */
function describeMissingOriginHead(project: string, gitMessage: string): string {
  const remotes = git(project, ["remote"]);
  if (!remotes.ok) {
    // Not a git repository, a path that has been moved away, a git that
    // refused outright - its own words, which name the real problem.
    return `${project}: ${remotes.message}`;
  }
  if (!remotes.out.split("\n").some((name) => name.trim() === "origin")) {
    return `${project} has no "origin" remote, so it has no default branch to be behind`;
  }
  return (
    `origin/HEAD is not set in ${project} (${gitMessage}) - ` +
    "`git remote set-head origin -a` records which branch origin calls default"
  );
}

/**
 * The one wording both `fabrica status` and the live view show, or null
 * when there is nothing to mark (the branch contains origin's tip). Every
 * surface renders this string verbatim - a second copy of the sentence is
 * how two surfaces come to say different things about the same task.
 *
 * The freshness clause is the honest caveat on a local-refs-only reading:
 * it is as current as this checkout's last fetch, which Fabrica itself
 * performs when it cuts a line and before every fix round.
 */
export function describeBaseStanding(standing: BaseStanding): string | null {
  if (standing.status === "unknown") return `base unknown: ${standing.reason}`;
  if (standing.status === "current") return null;
  const fetched =
    standing.fetchedAgoMs === null ? "" : ` (origin last fetched ${formatAge(standing.fetchedAgoMs)} ago)`;
  return `behind origin/${standing.base}, a fix will rebase${fetched}`;
}

/** Both halves at once - the reading and its label - for a caller that
 * only wants the string. Null means "nothing to mark". */
export function describeBaseStandingOf(project: string | null, branch: string | null, now?: number): string | null {
  return describeBaseStanding(baseStandingOf(project, branch, now));
}
