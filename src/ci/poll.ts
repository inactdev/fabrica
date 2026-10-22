// WHEN to read, and when to stop. The one loop in this module.
//
// Bounded three ways, deliberately:
//   - `waitMs`      - the whole wait. Past it, whatever is still running
//                     is recorded as unknown (issue #267's fourth ask),
//                     never as green.
//   - `appearMs`    - how long "GitHub reports no checks at all" is read
//                     as "they have not registered yet" rather than as
//                     "this repository has no CI". Much shorter than the
//                     whole wait, and a different question: a repository
//                     with no workflows must not cost every task twenty
//                     idle minutes, and a workflow that takes ten seconds
//                     to appear must not be missed.
//   - the request timeout in `github.ts`, per call.
//
// Nothing here executes anything (issue #64's ruling stands: Fabrica runs
// no project check on the host). It reads results GitHub already has.

import { CiError } from "./errors.ts";
import { createGithubReader } from "./github.ts";
import type { FetchLike, GithubReader } from "./github.ts";
import { attachLogTails, MAX_LOGS_FETCHED } from "./logs.ts";
import { readChecks, readHeadSha } from "./read.ts";
import { summarizeChecks } from "./report.ts";
import type { ChecksReport, ConcludedCheck, PullRequestRef, UnresolvedCheck } from "./types.ts";

/** The whole bounded wait for a pull request's checks to conclude.
 * Sized to a real repository's own CI rather than to anything Fabrica
 * does: this project's own `docker-tests` job runs the full suite, and
 * a container rehearsal is slower still. Past it the report says which
 * checks were still running - which is the honest answer, and the one
 * the Client can act on - instead of pretending they passed. */
export const DEFAULT_CHECKS_WAIT_MS = 20 * 60 * 1000; // 20 minutes

/** How long an empty answer is read as "not registered yet". GitHub
 * creates a check run when a workflow is queued, which follows the push
 * within seconds; a minute is generous for that and still cheap for a
 * repository that has no CI at all. Deliberately a different order of
 * magnitude from DEFAULT_CHECKS_WAIT_MS - do not harmonize them, they
 * answer different questions. */
export const DEFAULT_CHECKS_APPEAR_MS = 60 * 1000; // 1 minute

/** How often the two endpoints are asked. Matched to the heartbeat
 * interval (`attempts.ts`'s DEFAULT_HEARTBEAT_INTERVAL_MS) so a poll
 * tick and a liveness tick cost one wake-up between them, and so the
 * whole wait is at most a couple of hundred requests - comfortably
 * inside GitHub's hourly quota. */
export const DEFAULT_CHECKS_POLL_INTERVAL_MS = 15_000;

export interface PollOptions {
  token: string;
  /** Test seam: a local fake GitHub. The real base otherwise. */
  baseUrl?: string;
  fetchImpl?: FetchLike;
  reader?: GithubReader;
  waitMs?: number;
  appearMs?: number;
  pollIntervalMs?: number;
  /** Test seams for the clock and the sleep, so a test drives a whole
   * expired wait without spending one. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called once per concluded check, the first time this poll sees it
   * conclude - which is what lets the record carry one event per check
   * as it happens rather than a batch at the end. */
  onConcluded?: (check: ConcludedCheck) => void;
  /** Called once per tick that is about to wait, so the caller can keep
   * a liveness signal landing while this loop holds the round open.
   * Deliberately a callback rather than this module reaching for
   * `attempts.ts`'s `withHeartbeat`: that lives under src/foreman, whose
   * `judge.ts` is this module's own caller, and a cycle between the two
   * is not worth one shared timer. Must not throw - see the call site. */
  onTick?: () => void;
}

/**
 * Reads `ref`'s checks until every one has concluded, the wait expires,
 * or there is nothing to wait for. Never throws: a read that cannot be
 * made at all comes back as a report with verdict "unreadable" and the
 * reason, because a task must not fail over somebody else's API.
 *
 * `onConcluded` fires at most once per check name+source, so a check
 * seen concluded on three consecutive ticks is reported once.
 */
export async function pollPullRequestChecks(
  prUrl: string,
  ref: PullRequestRef,
  opts: PollOptions
): Promise<ChecksReport> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const waitMs = opts.waitMs ?? DEFAULT_CHECKS_WAIT_MS;
  const appearMs = opts.appearMs ?? DEFAULT_CHECKS_APPEAR_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_CHECKS_POLL_INTERVAL_MS;
  const reader = opts.reader ?? createGithubReader({ token: opts.token, baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl });

  const startedAt = now();
  let sha = "";
  let concluded: ConcludedCheck[] = [];
  let unresolved: UnresolvedCheck[] = [];
  let truncated = false;
  let logsFetched = 0;
  let logsSkippedForCap = 0;
  const announced = new Set<string>();

  try {
    sha = await readHeadSha(reader, ref);

    for (;;) {
      const snapshot = await readChecks(reader, ref, sha);
      concluded = snapshot.concluded;
      unresolved = snapshot.unresolved;
      truncated = snapshot.truncated;

      const fresh = concluded.filter((check) => !announced.has(keyOf(check)));
      // A newly-red check gets its log fetched BEFORE it is announced,
      // so the one event the record carries for it already has the log
      // on it - which is what issue #267 asks for. Fetched here rather
      // than once at the end for a second reason too: the download link
      // expires after a minute, and the end of a twenty-minute wait is a
      // long way from the moment the job finished.
      const freshRed = fresh.filter((check) => check.red);
      if (freshRed.length > 0) {
        const spent = await attachLogTails(reader, ref, sha, freshRed, {
          budget: Math.max(0, MAX_LOGS_FETCHED - logsFetched),
        });
        logsFetched += spent.fetched;
        logsSkippedForCap += spent.skippedForCap;
      }
      for (const check of fresh) {
        announced.add(keyOf(check));
        opts.onConcluded?.(check);
      }

      const elapsed = now() - startedAt;
      // Nothing at all yet: give the checks a short window to register
      // before concluding this repository simply has none.
      if (concluded.length === 0 && unresolved.length === 0) {
        if (elapsed >= appearMs) break;
      } else if (unresolved.length === 0) {
        break;
      } else if (elapsed >= waitMs) {
        break;
      }
      // Swallowed for the same reason `withHeartbeat` swallows its own
      // tick (`attempts.ts`): the one thing this can realistically
      // throw is an `appendEvent` failing on a full disk, and losing a
      // liveness signal must never lose the round.
      try {
        opts.onTick?.();
      } catch {
        // deliberately ignored - see above
      }
      await sleep(pollIntervalMs);
    }
  } catch (err) {
    const problem = err instanceof CiError ? err.message : err instanceof Error ? err.message : String(err);
    const partial: ChecksReport = {
      prUrl,
      sha,
      verdict: "unreadable",
      concluded,
      unresolved,
      summary: "",
      problem,
    };
    return { ...partial, summary: summarizeChecks(partial, { truncated, logsSkippedForCap }) };
  }

  const red = concluded.filter((check) => check.red);

  const verdict =
    red.length > 0
      ? "red"
      : unresolved.length > 0
        ? "unknown"
        : concluded.length > 0
          ? "green"
          : "none";

  const report: ChecksReport = { prUrl, sha, verdict, concluded, unresolved, summary: "" };
  return { ...report, summary: summarizeChecks(report, { truncated, logsSkippedForCap }) };
}

/** Identity of a check across ticks: the mechanism plus the name. Not the
 * check run id - a re-run of the same job answers under a new id, and
 * announcing that as a second check would double-count it. */
function keyOf(check: ConcludedCheck): string {
  return `${check.source}:${check.name}`;
}
