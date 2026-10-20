// ForemanError: every refusal this module produces carries a `code` for
// callers that need to branch on it, and a `message` written to be shown
// to the Client verbatim.

export type ForemanErrorCode =
  | "no-brain"
  | "invalid-attempts"
  | "invalid-issue"
  | "missing-check"
  | "inspector-not-ready"
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
