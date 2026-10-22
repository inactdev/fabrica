// The shapes `src/ci/` works in. Internal to this module plus its one
// caller (`src/foreman/judge.ts`): nothing here is a promise to the
// Client about a seam, so none of it belongs in `contract/surface.ts`
// (which is also a path `rule9-gate.yml` protects - see AGENTS.md).

/** One pull request on GitHub, as the API addresses it. */
export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
}

/** Which of GitHub's two result mechanisms reported a check. They are
 * read from two different endpoints and carry different vocabularies -
 * a check run "concludes", a commit status has a "state" - so the record
 * says which one it was rather than flattening them. */
export type CheckSource = "check-run" | "commit-status";

/** A check that has reached an answer. `conclusion` is GitHub's own word,
 * verbatim and unmapped; `red` is Fabrica's reading of it (see
 * `isRedConclusion`). */
export interface ConcludedCheck {
  name: string;
  source: CheckSource;
  conclusion: string;
  red: boolean;
  /** Where a human reads this run - a check run's `html_url` (falling
   * back to `details_url`) or a commit status's `target_url`. Null when
   * GitHub reported none. */
  url: string | null;
  /** The end of the job's own log, when this check is red and the API
   * served one (`logs.ts`). Absent for a green check, for a commit
   * status (no log endpoint exists for one), and whenever the log could
   * not be fetched. */
  logTail?: string;
  /** A check run's own id, carried only so `logs.ts` can match it to the
   * Actions job that produced it. Deliberately stripped before anything
   * is written to the record (`watch.ts`): an opaque id is nothing a
   * reader of the record can act on. Absent for a commit status, which
   * has no such id and no log endpoint either. */
  checkRunId?: number;
}

/** A check that had not answered yet when the wait ran out - recorded as
 * exactly that, never as green (issue #267's fourth ask). */
export interface UnresolvedCheck {
  name: string;
  source: CheckSource;
  /** GitHub's own word for where it had got to - "queued",
   * "in_progress", "pending". */
  status: string;
  url: string | null;
}

/**
 * What one read of a pull request's published checks found.
 *
 * - `"green"`: at least one check concluded and none of them is red.
 * - `"red"`: at least one concluded check is red. The only verdict that
 *   turns the round's delivery red.
 * - `"unknown"`: nothing is red, but the wait expired with checks still
 *   running. Never green, and never red either.
 * - `"none"`: GitHub reported no check at all for this commit, even
 *   after the grace window - a repository with no CI, which is its own
 *   business (issue #267's non-goal), not a problem to report.
 * - `"unreadable"`: the API could not be read (no token, a network
 *   failure, a refusal). `problem` says why.
 */
export type ChecksVerdict = "green" | "red" | "unknown" | "none" | "unreadable";

export interface ChecksReport {
  prUrl: string;
  /** The pull request's head commit, as GitHub reports it - the ref every
   * read below was taken for. Empty only when the verdict is
   * "unreadable" and even that read failed. */
  sha: string;
  verdict: ChecksVerdict;
  concluded: ConcludedCheck[];
  unresolved: UnresolvedCheck[];
  /** One short phrase for a task line: "5 green, rehearsal red". */
  summary: string;
  /** Set only for "unreadable": what stopped the read, in words meant to
   * be shown to the Client verbatim. */
  problem?: string;
}
