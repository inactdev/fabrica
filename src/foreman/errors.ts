// ForemanError: every refusal this module produces carries a `code` for
// callers that need to branch on it, and a `message` written to be shown
// to the Client verbatim.

export type ForemanErrorCode =
  | "no-brain"
  | "invalid-attempts"
  | "invalid-issue"
  /** `--issue` named a real-looking issue that could not be read before
   * the task started: no GitHub repository to resolve it against, no
   * token, GitHub unreachable, no such issue, or one past the ceiling
   * for an issue carried into a brief. Carries the cause verbatim -
   * see src/foreman/task-issue.ts. */
  | "issue-unavailable"
  /** A project names knowledge-base notes (projects.toml's
   * `[projects.<name>.knowledge]`) that could not be carried into the
   * brief: the knowledge base is not there, it has no `notes/` folder, a
   * named note has no file, a named note has no front-matter title, or
   * the brief would be past its size ceiling with them in. Raised before
   * any ProductionLine is cut - see src/foreman/task-knowledge.ts. */
  | "knowledge-unavailable"
  /** The project commits a `tests.map` whose own text cannot be read - a
   * line that is not `pattern: tests`. Refused rather than skipped: a
   * half-read map would name fewer tests in the brief and report more
   * touched files as unmapped, both without anyone being told. Raised
   * before any ProductionLine is cut, like `knowledge-unavailable`, and
   * carries src/testmap's own message, which names the line to edit -
   * see src/foreman/test-map.ts. */
  | "test-map-unreadable"
  | "missing-check"
  | "inspector-not-ready"
  /** No reviewer could be settled for a project whose test changes need
   * one judged - see src/reviewer/resolve.ts for the three grounds. */
  | "reviewer-not-ready"
  | "project-not-a-repo"
  | "commit-failed"
  | "unknown-task"
  | "not-delivered"
  | "inspection-refused"
  | "already-closed"
  | "invalid-verdict"
  | "missing-note"
  | "no-questions-pending"
  | "already-answered"
  | "missing-answer"
  | "cap-refused"
  /** Issue #189's pause rule refused to start anything: a subscription
   * meter is past its refuse threshold. Carries the numbers and the
   * threshold in its message. Not a cap refusal - that one is about
   * dollars, this one about a flat-rate subscription's own window. */
  | "meter-refused"
  | "spend-unknown"
  | "invalid-cost"
  | "nothing-to-record"
  /** `stop` (issue #203) on a task that isn't running - already
   * delivered, already closed, waiting on an answer, or never started. */
  | "not-running"
  /** A model call failed twice (issue #199): it failed the way a
   * dropped connection fails, was retried once on the same model after
   * a short wait, and failed again. Carries the model, the first
   * failure's kind and the second failure's own words - see
   * src/foreman/transport-retry.ts. No model is ever swapped in to
   * recover from this; the task stops instead. */
  | "model-call-failed"
  /** The network a Worker's box was running on is gone (2026-10-18): its
   * task's own relay container stopped serving mid-attempt, so every
   * request the box makes is refused by an address with nothing
   * listening. Carries what the relay watcher reported, which names the
   * relay - a worker left to discover this itself says only
   * "ConnectionRefused", minutes later, if at all. */
  | "worker-network-gone";

export class ForemanError extends Error {
  readonly code: ForemanErrorCode;

  constructor(code: ForemanErrorCode, message: string) {
    super(message);
    this.name = "ForemanError";
    this.code = code;
  }
}

// Same shape as src/line/safety.ts's describeGitError — duplicated locally
// on purpose rather than imported across module boundaries.
export function describeGitError(err: unknown): string {
  const stderr = (err as { stderr?: Buffer | string } | undefined)?.stderr;
  if (stderr && stderr.toString().trim().length > 0) return stderr.toString().trim();
  return err instanceof Error ? err.message : String(err);
}
