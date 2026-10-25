// What a task's change IS, independent of where it sits in history: a
// `git patch-id --stable` of the branch's own diff. It goes on every
// attempt's receipt and on every pass's delivery, and a later pass says
// whether it matched the one stamped before it.
//
// The whole point is that the id survives a rebase. A branch rebased
// onto a moved origin has entirely different commit shas and an
// entirely different diff against its ORIGINAL fork point, while the
// change itself is byte-for-byte what it was. So the diff is taken
// against `merge-base(HEAD, origin/<default>)` - which, after a rebase,
// is origin's tip, and before one is the branch's own fork point. Both
// give the same patch id (Client ruling: "the merge-base of the attempt
// against the project's default branch at the moment of stamping - that
// is what keeps the fingerprint stable across a rebase onto newer
// upstream, which is the whole point"). Measured, not assumed - see
// `fingerprint.test.ts`'s rebase case.
//
// READ ONLY, and it never reaches the network. Origin's default branch
// comes from the local `refs/remotes/origin/HEAD` symref, exactly as
// `base-standing.ts` reads it and for the same reason: a report must
// not fetch. That costs nothing here, because `merge-base` is monotone
// - a newer upstream tip that descends from the one already on disk
// gives the same merge-base with the task's branch - and the two
// operations that move a task branch relative to upstream (cutting the
// line, and the fix round's rebase) both fetch before they do it.
//
// Nothing in this file throws. A fingerprint that cannot be taken is
// recorded as unstamped WITH ITS REASON and shown that way; it is never
// silently absent, and it never fails an attempt. A missing fingerprint
// is bookkeeping that could not be done, not work that went wrong.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
// The two record shapes themselves live beside the Receipt and Delivery
// fields that carry them (src/inspector/types.ts), the same way
// `ModelSource` does - the record's own shapes are that file's
// business. This module is where they are taken, compared and worded.
import type { ChangeFingerprint, FingerprintMatch } from "../inspector/types.ts";

export type { ChangeFingerprint, FingerprintMatch };

/** One pass's stamp as the record carries it, oldest pass first. */
export interface PassFingerprint {
  /** 1-based, counting this task's own passes. */
  pass: number;
  patchId: string;
}

/** A reason is one line on a status listing, so git's own stderr - which
 * runs to several - is cut to its first and capped. Same treatment, same
 * numbers, as `base-standing.ts` gives its own reasons. */
const REASON_MAX_LENGTH = 200;

/** `git diff` output scales with the changeset; node's 1 MiB default
 * would turn a large change into an unstamped one for no good reason. */
const MAX_DIFF_BYTES = 100 * 1024 * 1024;

function oneLine(text: string): string {
  const first = text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
  return first.length > REASON_MAX_LENGTH ? `${first.slice(0, REASON_MAX_LENGTH)}…` : first;
}

type GitText = { ok: true; out: string } | { ok: false; message: string };
type GitBytes = { ok: true; out: Buffer } | { ok: false; message: string };

function describe(err: unknown): string {
  const error = err as { stderr?: Buffer | string; message?: string };
  const stderr = error.stderr?.toString() ?? "";
  return oneLine(stderr.trim().length > 0 ? stderr : (error.message ?? String(err)));
}

/** One read-only git call. Never throws: every failure here is a reason
 * to record, not an exception to raise. */
function gitText(dir: string, args: string[], input?: Buffer): GitText {
  try {
    const out = execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      ...(input === undefined ? {} : { input }),
      maxBuffer: MAX_DIFF_BYTES,
    });
    return { ok: true, out: out.trim() };
  } catch (err) {
    return { ok: false, message: describe(err) };
  }
}

function gitBytes(dir: string, args: string[]): GitBytes {
  try {
    const out = execFileSync("git", args, {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: MAX_DIFF_BYTES,
    });
    return { ok: true, out };
  } catch (err) {
    return { ok: false, message: describe(err) };
  }
}

/** The stamp for a change that could not be hashed, with the reason the
 * record and both surfaces show. */
export function unstamped(reason: string, base: string | null = null, baseBranch: string | null = null): ChangeFingerprint {
  return { patchId: null, base, baseBranch, reason };
}

/** Why an attempt that never reached a commit has no stamp - the exact
 * wording for the three ways that happens (a crash mid-call, a host-side
 * git step that preempted the commit, a commit that failed), so the
 * record never implies git was asked and refused. */
export const NOT_COMMITTED = "the attempt's changes were never committed, so there is nothing to fingerprint";

/** Why a task already on the record when fingerprints arrived has none:
 * the record is append-only, so nothing is backfilled and nothing is
 * computed retroactively (Client ruling). Those tasks read as unstamped
 * and say so, rather than reading as a stamp that failed. */
export const UNSTAMPED_OLD_RECORD = "recorded before fingerprints existed; nothing is computed retroactively";

/**
 * The stamp for whatever `workdir`'s branch currently holds.
 *
 * `workdir` is a ProductionLine's own throwaway worktree. A linked
 * worktree shares `refs/remotes/*` with its project, so origin's default
 * branch and the merge-base are both readable from inside it - no
 * project path needed, and no chance of reading one branch's refs while
 * diffing another's.
 *
 * The diff's flags are pinned rather than inherited: `--no-ext-diff` and
 * `--no-textconv` keep a project's own diff drivers from deciding what
 * the patch text is, and `--no-renames` pins rename detection, which is
 * config-driven and genuinely changes the resulting id. (The `index`
 * lines' abbreviation length does NOT - checked on git 2.54.0 - so the
 * stamp does not drift as a repository grows.)
 */
export function changeFingerprintOf(workdir: string): ChangeFingerprint {
  // Checked before git rather than after: with a cwd that is not there,
  // every call below fails as "spawnSync git ENOENT", which names node's
  // own plumbing instead of the one thing actually wrong.
  if (!existsSync(workdir)) return unstamped(`the working folder ${workdir} is not there`);

  const head = gitText(workdir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (!head.ok || head.out.length === 0) {
    return unstamped(
      `origin/HEAD is not set in ${workdir}, so there is no default branch to measure the change against` +
        (head.ok ? "" : ` (${head.message})`)
    );
  }
  // "origin/main" -> "main". The id itself does not care, but the
  // reasons and the labels name the branch as the Client knows it.
  const baseBranch = head.out.replace(/^origin\//, "");
  if (baseBranch.length === 0) {
    return unstamped(`origin/HEAD names "${head.out}", which is not a branch of origin`);
  }

  const baseRef = `refs/remotes/origin/${baseBranch}`;
  const mergeBase = gitText(workdir, ["merge-base", "HEAD", baseRef]);
  if (!mergeBase.ok || mergeBase.out.length === 0) {
    return unstamped(
      `git could not find where this branch forked from origin/${baseBranch}` +
        (mergeBase.ok ? "" : `: ${mergeBase.message}`),
      null,
      baseBranch
    );
  }
  const base = mergeBase.out;

  const diff = gitBytes(workdir, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    base,
    "HEAD",
  ]);
  if (!diff.ok) {
    return unstamped(`git could not diff this branch against origin/${baseBranch}: ${diff.message}`, base, baseBranch);
  }
  if (diff.out.length === 0) {
    // `git patch-id` prints nothing at all for empty input, so there is
    // no id to record and no honest way to invent one. Said as what it
    // is rather than as a failure.
    return unstamped(`this branch holds no change against origin/${baseBranch} yet`, base, baseBranch);
  }

  const stamped = gitText(workdir, ["patch-id", "--stable"], diff.out);
  if (!stamped.ok) {
    return unstamped(`git patch-id could not read this branch's diff: ${stamped.message}`, base, baseBranch);
  }
  // "<patch id> <commit id>" - the second is all zeroes for a plain
  // diff, which is what this always feeds it.
  const patchId = stamped.out.split(/\s+/)[0] ?? "";
  if (patchId.length === 0) {
    return unstamped(`git patch-id produced no id for this branch's diff`, base, baseBranch);
  }
  return { patchId, base, baseBranch };
}

/**
 * How `current` stands against the stamps the task's earlier passes
 * carried. Null when there is nothing to say: no earlier pass was
 * stamped, or this pass is not stamped itself - in which case the stamp's
 * own `reason` is what the record and the Client's surfaces show, and no
 * claim is made in either direction about earlier observations.
 */
export function compareFingerprint(prior: PassFingerprint[], current: ChangeFingerprint): FingerprintMatch | null {
  if (current.patchId === null) return null;
  const last = prior.at(-1);
  if (last === undefined) return null;
  const matched = [...prior].reverse().find((entry) => entry.patchId === current.patchId);
  return {
    matched: matched !== undefined,
    previous: last.patchId,
    previousPass: last.pass,
    ...(matched === undefined ? {} : { matchedPass: matched.pass }),
    voidsEarlierObservations: matched === undefined,
  };
}

/** The two fields a pass's delivery carries about its own change,
 * spread onto the `Delivery` object at each build site. One shape so
 * every outcome - green, red, capped, paused, conflicted, unchanged -
 * is stamped the same way, and none can quietly go unstamped. */
export interface DeliveryStamp {
  fingerprint: ChangeFingerprint;
  fingerprintMatch?: FingerprintMatch;
}

/**
 * The stamp a delivery carries: what `workdir`'s branch holds right
 * now, and how that compares with the task's earlier passes.
 *
 * Called at the point in each path where the branch has finished
 * moving for this pass - after the pass's own commit on the ordinary
 * path, after the abort on the rebase-conflict path - so the stamp
 * describes exactly what is being handed to the Client.
 */
export function stampFor(workdir: string, prior: PassFingerprint[]): DeliveryStamp {
  const fingerprint = changeFingerprintOf(workdir);
  const match = compareFingerprint(prior, fingerprint);
  return { fingerprint, ...(match === null ? {} : { fingerprintMatch: match }) };
}

/** How many characters of a patch id a line of prose shows - the same
 * length git itself abbreviates an object name to, for the same reason:
 * enough to recognise, short enough to read. The record always keeps
 * the whole id. */
export const SHORT_PATCH_ID_LENGTH = 7;

export function shortPatchId(patchId: string): string {
  return patchId.slice(0, SHORT_PATCH_ID_LENGTH);
}

/**
 * The one wording every surface shows for a stamp and how it compares -
 * `fabrica status`, `fabrica log`, and `delivery.md` all render this
 * string verbatim. A second copy of the sentence is how two surfaces
 * come to say different things about the same task.
 *
 * There is always something to say: a record with no fingerprint on it
 * at all reads as unstamped too, since that is exactly what it is.
 */
export function describeFingerprint(
  fingerprint: ChangeFingerprint | undefined,
  match?: FingerprintMatch | null
): string {
  if (fingerprint === undefined) return `fingerprint unstamped: ${UNSTAMPED_OLD_RECORD}`;
  if (fingerprint.patchId === null) {
    return `fingerprint unstamped: ${fingerprint.reason ?? "no reason recorded"}`;
  }
  const id = `fingerprint ${shortPatchId(fingerprint.patchId)}`;
  if (match === undefined || match === null) return id;
  if (!match.matched) {
    return (
      `${id}, changed from pass ${match.previousPass} (${shortPatchId(match.previous)}) - every earlier ` +
      `Inspector stamp, check result and CI conclusion on this task is void`
    );
  }
  return match.matchedPass === match.previousPass
    ? `${id}, unchanged since pass ${match.matchedPass}`
    : `${id}, back to the change pass ${match.matchedPass} carried (pass ${match.previousPass} had ` +
        `${shortPatchId(match.previous)})`;
}
