// Which run of a check is the one to read (issue #348).
//
// A commit can carry several check runs of the same name. The ordinary
// cause is a workflow with `concurrency: cancel-in-progress` triggered
// on `opened`, `synchronize` and `edited`: every push and every
// description edit starts a fresh run and stops the one before it, so
// the commit ends up holding two or three `cancelled` runs of a check
// plus the one that actually finished.
//
// Reading each of those on its own terms - which is what Fabrica did
// before this file existed - says a check is red when the repository's
// own pull request page says it passed. That cost a real task a whole
// second attempt, with nothing to fix, and delivered red on a commit
// whose every check was green (issue #348).
//
// `filter=latest` on the endpoint does not solve this: GitHub documents
// it as no more than "Filters check runs by their completed_at
// timestamp. latest returns the most recent check runs", with nothing
// about collapsing per name, and the case above is the proof that it
// does not - each workflow run opens its own check suite. So the
// reduction is ours, here, in front of everything else.
//
// Two rules, and they are fixed for every project (Client's
// clarification on issue #348 - only the retry is a setting):
//
//   1. A cancelled run is not a result. It is dropped before anything
//      is judged, never read as red and never read as green.
//   2. The newest remaining run of a check is its answer - its pass or
//      its fail, and nothing older than it.
//
// A check whose every run on this commit was cancelled therefore has no
// answer yet, which is what `UnresolvedCheck` already means: `poll.ts`
// keeps waiting for the newer run, and if the wait expires with still
// nothing the report says `unknown` - never red, and so never a retry.

import { isNoResultConclusion, isRedConclusion, isUnresolvedCheckRunStatus } from "./conclusions.ts";
import type { ConcludedCheck, UnresolvedCheck } from "./types.ts";

/** One check run as GitHub reported it, carrying only the fields that
 * decide which run of a check is its answer. `read.ts` builds these;
 * nothing else does. */
export interface CheckRunRead {
  /** The display name `read.ts` already resolved - runs are grouped by
   * it, since it is also how `poll.ts` identifies a check across ticks. */
  name: string;
  /** GitHub's own word: queued, in_progress, waiting, requested,
   * pending, completed. */
  status: string;
  /** GitHub's own word, or null while the run has not finished. */
  conclusion: string | null;
  url: string | null;
  id?: number;
  /** `started_at`, GitHub's own ISO 8601 string. Documented nullable, so
   * optional here. */
  startedAt?: string;
}

/** The answers one read of the check-runs endpoint came to, one entry
 * per distinct check name. */
export interface LatestRuns {
  concluded: ConcludedCheck[];
  unresolved: UnresolvedCheck[];
}

/** What an `UnresolvedCheck` carries as its `status` when every run of
 * that check on this commit was cancelled. GitHub's own word, so the
 * record and the worker's own correction both say plainly why this check
 * has no answer rather than implying it is still running. */
export const ONLY_CANCELLED = "cancelled";

/**
 * One answer per check name: the newest run that is not cancelled.
 *
 * Order of the result follows the order the names first appeared in
 * `runs`, which is GitHub's own listing order - a report must not
 * reshuffle the checks between two ticks.
 */
export function latestRunPerCheck(runs: CheckRunRead[]): LatestRuns {
  const concluded: ConcludedCheck[] = [];
  const unresolved: UnresolvedCheck[] = [];

  for (const group of groupByName(runs)) {
    // Rule 1: a cancelled run is not a result. Dropped here, before
    // anything below can read it as either colour.
    const answering = group.filter((run) => !isCancelled(run));
    if (answering.length === 0) {
      // Every run of this check was stopped before it judged anything,
      // so the newest run of it has not landed yet. Its link is still
      // worth carrying - it is where a human sees the cancellation.
      const newest = newestOf(group);
      unresolved.push({ name: newest.name, source: "check-run", status: ONLY_CANCELLED, url: newest.url });
      continue;
    }
    // Rule 2: the newest of what is left answers for the check - which
    // is also what GitHub's own pull request page shows for it, and what
    // its required-status-check settings judge.
    const run = newestOf(answering);
    if (isUnfinished(run)) {
      unresolved.push({ name: run.name, source: "check-run", status: run.status || "unknown", url: run.url });
      continue;
    }
    concluded.push({
      name: run.name,
      source: "check-run",
      conclusion: run.conclusion!,
      red: isRedConclusion(run.conclusion!),
      url: run.url,
      // Carried only so `logs.ts` can match this check against its
      // Actions job; stripped before anything reaches the record.
      ...(typeof run.id === "number" ? { checkRunId: run.id } : {}),
    });
  }

  return { concluded, unresolved };
}

/** The runs of each distinct name, names in first-appearance order. */
function groupByName(runs: CheckRunRead[]): CheckRunRead[][] {
  const groups = new Map<string, CheckRunRead[]>();
  for (const run of runs) {
    const group = groups.get(run.name);
    if (group === undefined) groups.set(run.name, [run]);
    else group.push(run);
  }
  return [...groups.values()];
}

function isCancelled(run: CheckRunRead): boolean {
  return run.conclusion !== null && isNoResultConclusion(run.conclusion);
}

/** Whether this run has yet to answer. `completed` is the only status
 * that carries a conclusion, and a completed run with none is read as
 * unfinished rather than as an empty answer. */
function isUnfinished(run: CheckRunRead): boolean {
  return isUnresolvedCheckRunStatus(run.status) || run.conclusion === null;
}

function newestOf(runs: CheckRunRead[]): CheckRunRead {
  return runs.reduce((best, run) => (isPreferredOver(run, best) ? run : best));
}

/**
 * Which of two runs of the same check is the one to read, most
 * significant rule first:
 *
 *   1. the later `started_at`. The only documented field that orders a
 *      run that has not finished yet, which is exactly the case that
 *      matters - `completed_at` is null for it.
 *   2. the larger `id`. Newer in practice, but documented nowhere as
 *      monotonic, so it only ever breaks a tie.
 *   3. a run that has answered, over one that has not.
 *   4. a red answer, over a green one.
 *
 * The last two exist so that two runs nothing separates in time can
 * never resolve into a pass by accident, and so the answer never
 * depends on the order GitHub happened to list them in.
 */
function isPreferredOver(run: CheckRunRead, best: CheckRunRead): boolean {
  const runStarted = startedAtMs(run);
  const bestStarted = startedAtMs(best);
  if (runStarted !== bestStarted) return runStarted > bestStarted;

  const runId = run.id ?? -1;
  const bestId = best.id ?? -1;
  if (runId !== bestId) return runId > bestId;

  if (isUnfinished(run) !== isUnfinished(best)) return !isUnfinished(run);
  return isRedAnswer(run) && !isRedAnswer(best);
}

/** `started_at` as a number, with "GitHub reported none, or something
 * unparseable" sorting as the oldest possible run - a missing timestamp
 * is not evidence of being newest. */
function startedAtMs(run: CheckRunRead): number {
  if (run.startedAt === undefined) return Number.NEGATIVE_INFINITY;
  const at = Date.parse(run.startedAt);
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
}

function isRedAnswer(run: CheckRunRead): boolean {
  return !isUnfinished(run) && isRedConclusion(run.conclusion!);
}
