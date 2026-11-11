// One function per documented endpoint this module reads, each turning
// GitHub's JSON into this module's own shapes and nothing more. Kept
// apart from `poll.ts` (which decides WHEN to read) and `report.ts`
// (which decides how to say it) so a shape change on GitHub's side is a
// change to this file alone.
//
// Endpoints, verified against GitHub's current REST reference
// (2026-10-22):
//   GET /repos/{owner}/{repo}/pulls/{pull_number}            -> head.sha
//   GET /repos/{owner}/{repo}/commits/{ref}/check-runs       -> check_runs[]
//   GET /repos/{owner}/{repo}/commits/{ref}/status           -> statuses[]
//
// The combined-status endpoint already resolves to the latest status per
// context, so a commit's whole status history is never paged back
// through - the same documented fact `.github/workflows/rule9-gate.yml`'s
// two jobs already lean on.

import { CiError } from "./errors.ts";
import { isRedConclusion, isUnresolvedCommitStatusState } from "./conclusions.ts";
import { latestRunPerCheck } from "./latest.ts";
import type { CheckRunRead } from "./latest.ts";
import type { GithubReader } from "./github.ts";
import type { ConcludedCheck, PullRequestRef, UnresolvedCheck } from "./types.ts";

/** The endpoint's documented maximum page size - fewer sequential calls
 * per poll tick, and so less chance of tripping a secondary rate limit.
 * One page is deliberately all that is read: a commit with more than a
 * hundred checks on it is not a case this feature is for, and the
 * summary says plainly when something was left out (`report.ts`). */
export const PAGE_SIZE = 100;

/** What one read of both endpoints found, before any verdict is drawn. */
export interface ChecksSnapshot {
  concluded: ConcludedCheck[];
  unresolved: UnresolvedCheck[];
  /** True when either endpoint reported more entries than one page
   * holds, so the snapshot is known to be partial. */
  truncated: boolean;
}

/** The pull request's current head commit - read from the API rather than
 * from the local branch, so the sha every check is read for is the one
 * GitHub itself says the pull request is at. */
export async function readHeadSha(reader: GithubReader, ref: PullRequestRef): Promise<string> {
  const body = await reader.json(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`);
  const head = asObject(body)?.head;
  const sha = asObject(head)?.sha;
  if (typeof sha !== "string" || sha.length === 0) {
    throw new CiError(
      "malformed",
      `GitHub's answer for pull request #${ref.number} carried no head commit, so there is no ref to read checks for.`
    );
  }
  return sha;
}

/** Both mechanisms' results for one commit, in one snapshot. */
export async function readChecks(
  reader: GithubReader,
  ref: PullRequestRef,
  sha: string
): Promise<ChecksSnapshot> {
  const runs = await readCheckRuns(reader, ref, sha);
  const statuses = await readCommitStatuses(reader, ref, sha);
  return {
    concluded: [...runs.concluded, ...statuses.concluded],
    unresolved: [...runs.unresolved, ...statuses.unresolved],
    truncated: runs.truncated || statuses.truncated,
  };
}

/** `filter=latest` is the endpoint's own default and is passed
 * explicitly, as the cheapest narrowing available - but it is NOT what
 * makes one check answer once. GitHub documents it as no more than
 * "Filters check runs by their completed_at timestamp. latest returns
 * the most recent check runs", which says nothing about collapsing runs
 * that share a name, and issue #348 is the proof that it does not: one
 * commit carried two cancelled runs of a check and a later successful
 * run of the same check, and all three arrived here. Each workflow run
 * opens its own check suite, which is the level `latest` appears to work
 * at.
 *
 * So which run of a check answers for it is decided here, by
 * `latestRunPerCheck` - see `latest.ts` for the two rules. */
async function readCheckRuns(
  reader: GithubReader,
  ref: PullRequestRef,
  sha: string
): Promise<ChecksSnapshot> {
  const body = asObject(
    await reader.json(`/repos/${ref.owner}/${ref.repo}/commits/${sha}/check-runs?per_page=${PAGE_SIZE}&filter=latest`)
  );
  const list = Array.isArray(body?.check_runs) ? body!.check_runs : [];
  const total = typeof body?.total_count === "number" ? body!.total_count : list.length;

  const runs: CheckRunRead[] = [];
  for (const entry of list) {
    const run = asObject(entry);
    if (run === null) continue;
    runs.push({
      name: typeof run.name === "string" && run.name.length > 0 ? run.name : "(unnamed check)",
      status: typeof run.status === "string" ? run.status : "",
      conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
      url: firstUrl(run.html_url, run.details_url),
      ...(typeof run.id === "number" ? { id: run.id } : {}),
      ...(typeof run.started_at === "string" ? { startedAt: run.started_at } : {}),
    });
  }
  return { ...latestRunPerCheck(runs), truncated: total > list.length };
}

async function readCommitStatuses(
  reader: GithubReader,
  ref: PullRequestRef,
  sha: string
): Promise<ChecksSnapshot> {
  const body = asObject(
    await reader.json(`/repos/${ref.owner}/${ref.repo}/commits/${sha}/status?per_page=${PAGE_SIZE}`)
  );
  const list = Array.isArray(body?.statuses) ? body!.statuses : [];
  const total = typeof body?.total_count === "number" ? body!.total_count : list.length;

  const concluded: ConcludedCheck[] = [];
  const unresolved: UnresolvedCheck[] = [];
  for (const entry of list) {
    const status = asObject(entry);
    if (status === null) continue;
    const name = typeof status.context === "string" && status.context.length > 0 ? status.context : "(unnamed status)";
    const state = typeof status.state === "string" ? status.state : "";
    const url = firstUrl(status.target_url);
    if (state.length === 0 || isUnresolvedCommitStatusState(state)) {
      unresolved.push({ name, source: "commit-status", status: state || "unknown", url });
      continue;
    }
    concluded.push({ name, source: "commit-status", conclusion: state, red: isRedConclusion(state), url });
  }
  return { concluded, unresolved, truncated: total > list.length };
}

function asObject(value: unknown): Record<string, any> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

function firstUrl(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return null;
}
