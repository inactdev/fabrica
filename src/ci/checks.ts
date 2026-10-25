// The whole of what this module offers its caller: read the pull request
// Inspector just opened or updated, and answer with what the repository's
// own checks said about it.
//
// Nothing here writes to the record. That is deliberate: the one caller
// (`src/foreman/ci-checks.ts`) is what appends the events, exactly the
// way `src/foreman/inspection.ts` - not the `Inspector` adapter - appends
// Inspector's own. A test fakes the read; it cannot fake the recording.
//
// Everything that could go wrong on somebody else's service is absorbed
// here. A task never fails because GitHub was unreachable, rate-limited,
// or slow; the worst case is a report with verdict "unreadable", which
// leaves the round on Inspector's own verdict - exactly what it did
// before this existed.

import { parsePullRequestUrl } from "./pull-request.ts";
import { pollPullRequestChecks } from "./poll.ts";
import type { PollOptions } from "./poll.ts";
import { summarizeChecks } from "./report.ts";
import type { ChecksReport, PullRequestRef } from "./types.ts";

export interface ReadChecksOptions extends Omit<PollOptions, "token"> {
  /** The token every read in this module uses. Tests pass one directly;
   * the production caller passes `mintToken` instead. */
  token?: string;
  /**
   * Asked for a token once the pull request's own repository is known
   * (issue #187): the whole read is one GitHub App token scoped to that
   * repository, with only the four read permissions these endpoints
   * need (`src/githubapp/scopes.ts`'s `READ_CHECKS_PERMISSIONS`).
   *
   * One token for the whole poll rather than one per tick, deliberately:
   * an installation token lives an hour and the bounded wait is twenty
   * minutes, so a mint per tick would be a hundred extra API calls and a
   * hundred extra record entries for no narrowing at all - the scope is
   * identical every time.
   *
   * Reached only when `token` is not given. With neither, the read is
   * reported unreadable naming the setup step, never attempted
   * anonymously.
   */
  mintToken?: (ref: PullRequestRef) => Promise<string>;
}

/**
 * Reads `prUrl`'s checks. Returns `undefined` when there is nothing on
 * GitHub to read at all - `prUrl` is not a github.com pull request URL,
 * so there is no API behind it. That is not a failed read, it is nothing
 * to read (see `pull-request.ts`), which is why it is distinct from an
 * "unreadable" report.
 */
export async function readPullRequestChecks(
  prUrl: string,
  opts: ReadChecksOptions = {}
): Promise<ChecksReport | undefined> {
  const ref = parsePullRequestUrl(prUrl);
  if (ref === null) return undefined;

  let token: string;
  try {
    if (opts.token !== undefined) token = opts.token;
    else if (opts.mintToken !== undefined) token = await opts.mintToken(ref);
    else throw new Error("no GitHub App token source was given for reading this pull request's checks");
  } catch (err) {
    // Inspector has already pushed and opened the pull request through
    // the same App by the time this runs, so a mint failing here is
    // nearly unreachable in practice. Reported rather than thrown all
    // the same: the round's work is done and must not be lost to a
    // credential problem.
    return unreadableReport(prUrl, err);
  }

  return pollPullRequestChecks(prUrl, ref, { ...opts, token });
}

function unreadableReport(prUrl: string, err: unknown): ChecksReport {
  const base: ChecksReport = {
    prUrl,
    sha: "",
    verdict: "unreadable",
    concluded: [],
    unresolved: [],
    summary: "",
    problem: err instanceof Error ? err.message : String(err),
  };
  return { ...base, summary: summarizeChecks(base) };
}
