// The tail of a red check's own job log, when the API serves one (issue
// #267's first ask). Best effort throughout: a log that cannot be
// resolved or downloaded simply isn't attached, and nothing about the
// report changes.
//
// There is no documented way to go from a check run to the Actions job
// that produced it. The documented link runs the other way - a job
// carries `check_run_url` - so this walks that direction:
//
//   GET /repos/{o}/{r}/actions/runs?head_sha=<sha>   -> workflow_runs[].id
//   GET /repos/{o}/{r}/actions/runs/{id}/jobs        -> jobs[].{id,check_run_url}
//   GET /repos/{o}/{r}/actions/jobs/{job_id}/logs    -> 302 to a plain-text log
//
// Parsing a job id straight out of a check run's `details_url` would be
// one call instead of two, but that URL's shape is documented nowhere -
// so it is not used. Verified against GitHub's current REST reference
// (2026-10-22), including that the log endpoint answers 302 with a link
// that expires after one minute (see github.ts's `redirectText` for why
// that redirect is followed by hand).

import { PAGE_SIZE } from "./read.ts";
import type { GithubReader } from "./github.ts";
import type { ConcludedCheck, PullRequestRef } from "./types.ts";

/** How much of a red job's log is kept. The log lands in the record
 * (append-only, re-serialized onto every later "delivered" event of the
 * same task) and in the next attempt's brief, so the whole of a verbose
 * job's output cannot be stored - the same reasoning, and roughly the
 * same order of magnitude, as `attempts.ts`'s
 * MAX_RECEIPT_CHECK_OUTPUT_BYTES. The END is kept: a failing job says
 * what failed at the end. */
export const MAX_LOG_TAIL_BYTES = 8 * 1024;

/** How many red checks' logs one whole read fetches at most. Each costs a
 * redirect plus a download of a possibly large file, and a round that is
 * red in eight places does not need eight logs to be actionable. The
 * report says plainly when this cut something (`report.ts`). The budget
 * is spent across the whole poll, not per tick - `poll.ts` carries what
 * is left. */
export const MAX_LOGS_FETCHED = 3;

/**
 * Attaches `logTail` to as many of `red` as the API will serve, in
 * order, within `opts.budget`. Returns how much of that budget was spent
 * (an attempted download counts, served or not - the cost is the same)
 * and the number of red checks left without a log because the budget ran
 * out, so the caller can say so rather than let the omission look like
 * "no log existed".
 *
 * Mutates the checks in place: they are this module's own freshly-parsed
 * objects, and threading a parallel map of ids to tails back through
 * `poll.ts` would be two things to keep in step instead of one.
 */
export async function attachLogTails(
  reader: GithubReader,
  ref: PullRequestRef,
  sha: string,
  red: ConcludedCheck[],
  opts: { budget?: number } = {}
): Promise<{ fetched: number; skippedForCap: number }> {
  const wanted = red.filter((check) => typeof check.checkRunId === "number");
  if (wanted.length === 0) return { fetched: 0, skippedForCap: 0 };

  let budget = opts.budget ?? MAX_LOGS_FETCHED;
  // Nothing left to spend: every one of these is a log deliberately not
  // fetched, which the caller says out loud.
  if (budget <= 0) return { fetched: 0, skippedForCap: wanted.length };

  const jobByCheckRun = await mapJobsToCheckRuns(reader, ref, sha);
  if (jobByCheckRun.size === 0) return { fetched: 0, skippedForCap: 0 };

  let fetched = 0;
  let skippedForCap = 0;
  for (const check of wanted) {
    const jobId = jobByCheckRun.get(check.checkRunId!);
    if (jobId === undefined) continue;
    if (budget <= 0) {
      skippedForCap += 1;
      continue;
    }
    budget -= 1;
    fetched += 1;
    const tail = await jobLogTail(reader, ref, jobId);
    if (tail !== null) check.logTail = tail;
  }
  return { fetched, skippedForCap };
}

/** check run id -> Actions job id, for every job of every workflow run on
 * this commit. Empty when nothing could be read - this whole lookup is
 * an extra, so a failure here is not the report's failure. */
async function mapJobsToCheckRuns(
  reader: GithubReader,
  ref: PullRequestRef,
  sha: string
): Promise<Map<number, number>> {
  const byCheckRun = new Map<number, number>();
  let runIds: number[];
  try {
    const body = await reader.json(
      // exclude_pull_requests trims a payload this lookup has no use for.
      `/repos/${ref.owner}/${ref.repo}/actions/runs?head_sha=${sha}&per_page=${PAGE_SIZE}&exclude_pull_requests=true`
    );
    const list = (body as { workflow_runs?: unknown })?.workflow_runs;
    runIds = Array.isArray(list)
      ? list.map((run) => (run as { id?: unknown })?.id).filter((id): id is number => typeof id === "number")
      : [];
  } catch {
    return byCheckRun;
  }

  for (const runId of runIds) {
    try {
      const body = await reader.json(
        `/repos/${ref.owner}/${ref.repo}/actions/runs/${runId}/jobs?per_page=${PAGE_SIZE}&filter=latest`
      );
      const jobs = (body as { jobs?: unknown })?.jobs;
      if (!Array.isArray(jobs)) continue;
      for (const entry of jobs) {
        const job = entry as { id?: unknown; check_run_url?: unknown };
        const checkRunId = checkRunIdOf(job.check_run_url);
        if (typeof job.id !== "number" || checkRunId === null) continue;
        byCheckRun.set(checkRunId, job.id);
      }
    } catch {
      // One unreadable workflow run must not lose the others' jobs.
    }
  }
  return byCheckRun;
}

/** The trailing id of a job's documented `check_run_url`
 * (".../check-runs/<id>"). Null for anything that does not end in one. */
function checkRunIdOf(checkRunUrl: unknown): number | null {
  if (typeof checkRunUrl !== "string") return null;
  const match = /\/check-runs\/(\d+)\s*$/.exec(checkRunUrl);
  if (match === null) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

async function jobLogTail(reader: GithubReader, ref: PullRequestRef, jobId: number): Promise<string | null> {
  let text: string | null;
  try {
    text = await reader.redirectText(`/repos/${ref.owner}/${ref.repo}/actions/jobs/${jobId}/logs`);
  } catch {
    return null;
  }
  if (text === null || text.length === 0) return null;
  return tailOf(text);
}

/** The last MAX_LOG_TAIL_BYTES of `text`, behind a marker naming what was
 * dropped, so a stored tail is never mistaken for a whole log. Mirrors
 * `attempts.ts`'s `gateForRecord`, including dropping the replacement
 * characters a cut landing mid-character leaves at the front. */
export function tailOf(text: string): string {
  const total = Buffer.byteLength(text, "utf8");
  if (total <= MAX_LOG_TAIL_BYTES) return text;
  const tail = Buffer.from(text, "utf8")
    .subarray(total - MAX_LOG_TAIL_BYTES)
    .toString("utf8")
    .replace(/^\uFFFD+/, "");
  return `[truncated, showing last ${Buffer.byteLength(tail, "utf8")} of ${total} bytes]\n${tail}`;
}
