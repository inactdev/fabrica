// ForemanError: every refusal this module produces carries a `code` for
// callers that need to branch on it, and a `message` written to be shown
// to the Client verbatim.

export type ForemanErrorCode =
  | "no-brain"
  | "invalid-attempts"
  | "missing-check"
  | "gate-baseline-unreadable"
  | "commit-failed"
  | "unknown-task"
  | "not-delivered"
  | "already-closed"
  | "invalid-verdict"
  | "missing-note"
  | "attempts-exhausted";

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
