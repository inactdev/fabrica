// Records what the repository's own checks said about the pull request
// Inspector opened or updated (issue #267).
//
// The same split `inspection.ts` already draws for Inspector itself: the
// outside call is a seam a test fakes (`ChecksReader`), and the record
// writing lives HERE, in Fabrica's own code, where no fake can skip it.
// That split is not cosmetic - it is the difference between "a round
// records one event per concluded check" being a property of the system
// and being a property of whatever reader happens to be installed.

import { appendEvent } from "../record/index.ts";
import { readPullRequestChecks } from "../ci/index.ts";
import type { ChecksReport, CheckSource, ChecksVerdict, ConcludedCheck } from "../ci/index.ts";

/**
 * The outside call: read `prUrl`'s checks and answer with what they said,
 * or `undefined` when there is nothing on GitHub to read (see
 * `src/ci/pull-request.ts`). `onTick` fires while the read is waiting, so
 * this module can keep a liveness signal landing on the record - a read
 * that waits out a slow rehearsal can hold a round open for minutes, and
 * `fabrica status` must not call that silence "quiet".
 *
 * Never throws: the real implementation absorbs every failure into an
 * "unreadable" report, and a caller-supplied fake must not either.
 */
export type ChecksReader = (prUrl: string, onTick: () => void) => Promise<ChecksReport | undefined>;

/** The production reader - the real GitHub read, with `src/ci/`'s own
 * defaults for the bounded wait and the poll interval. */
export const defaultChecksReader: ChecksReader = (prUrl, onTick) => readPullRequestChecks(prUrl, { onTick });

/** `"ci-check-concluded"`'s own details: one concluded check, exactly as
 * GitHub reported it, plus the tail of its job log when the API served
 * one for a red check. No opaque ids - `ConcludedCheck.checkRunId` is
 * `src/ci/`'s own plumbing and is stripped before anything is written. */
export interface CiCheckConcludedDetails {
  name: string;
  source: CheckSource;
  /** GitHub's own word, verbatim: success, failure, neutral, cancelled,
   * skipped, timed_out, action_required for a check run; error, failure,
   * success for a commit status. */
  conclusion: string;
  red: boolean;
  /** Where a human reads the run, or null when GitHub reported none. */
  url: string | null;
  logTail?: string;
}

/** `"ci-checks-finished"`'s own details: the round-level summary every
 * surface reads for a task line, plus the checks that never concluded
 * (issue #267's fourth ask - recorded as unknown, never as green). */
export interface CiChecksFinishedDetails {
  prUrl: string;
  sha: string;
  verdict: ChecksVerdict;
  /** The one short phrase `fabrica status`/`watch`/the live view show. */
  summary: string;
  green: number;
  red: string[];
  unknown: { name: string; source: CheckSource; status: string; url: string | null }[];
  /** Set only for verdict "unreadable". */
  problem?: string;
}

/**
 * Reads the pull request's checks and puts them on the task's record: one
 * `"ci-check-concluded"` per concluded check, then one
 * `"ci-checks-finished"` summary. Returns the report for the round's own
 * verdict to be drawn from (`judge.ts`), or `undefined` when there was
 * nothing to read - in which case nothing is recorded either, on purpose:
 * a pull request Fabrica cannot address over the API has no checks it
 * could honestly report on.
 */
export async function handToPullRequestChecks(
  recordHome: string,
  taskId: string,
  prUrl: string,
  reader: ChecksReader = defaultChecksReader
): Promise<ChecksReport | undefined> {
  const report = await reader(prUrl, () => {
    appendEvent(recordHome, { taskId, name: "heartbeat", details: { phase: "ci-checks" } });
  });
  if (report === undefined) return undefined;

  for (const check of report.concluded) {
    appendEvent(recordHome, { taskId, name: "ci-check-concluded", details: concludedDetails(check) });
  }
  appendEvent(recordHome, { taskId, name: "ci-checks-finished", details: finishedDetails(report) });
  return report;
}

/** The event's own shape, built explicitly rather than by spreading the
 * check: `checkRunId` is plumbing and must not reach the record. */
export function concludedDetails(check: ConcludedCheck): CiCheckConcludedDetails {
  return {
    name: check.name,
    source: check.source,
    conclusion: check.conclusion,
    red: check.red,
    url: check.url,
    ...(check.logTail === undefined ? {} : { logTail: check.logTail }),
  };
}

export function finishedDetails(report: ChecksReport): CiChecksFinishedDetails {
  const red = report.concluded.filter((check) => check.red);
  return {
    prUrl: report.prUrl,
    sha: report.sha,
    verdict: report.verdict,
    summary: report.summary,
    green: report.concluded.length - red.length,
    red: red.map((check) => check.name),
    unknown: report.unresolved.map((check) => ({
      name: check.name,
      source: check.source,
      status: check.status,
      url: check.url,
    })),
    ...(report.problem === undefined ? {} : { problem: report.problem }),
  };
}
