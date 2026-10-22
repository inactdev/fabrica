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

import { resolveGithubToken } from "../inspector/index.ts";
import { parsePullRequestUrl } from "./pull-request.ts";
import { pollPullRequestChecks } from "./poll.ts";
import type { PollOptions } from "./poll.ts";
import { summarizeChecks } from "./report.ts";
import type { ChecksReport } from "./types.ts";

export interface ReadChecksOptions extends Omit<PollOptions, "token"> {
  /** Resolved from Fabrica's own environment when omitted - the same
   * token, from the same resolver, Inspector publishes with (issue
   * #103's `resolveGithubToken`). Tests pass one directly. */
  token?: string;
  /** The environment the token is resolved from. Fabrica's own by
   * default; never modified. */
  env?: NodeJS.ProcessEnv;
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
    token = opts.token ?? resolveGithubToken(opts.env ?? process.env).token;
  } catch (err) {
    // The token is Inspector's own, and Inspector has already published
    // with it by the time this runs - so this is nearly unreachable in
    // practice. Reported rather than thrown all the same: the round's
    // work is done and must not be lost to a credential problem.
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
