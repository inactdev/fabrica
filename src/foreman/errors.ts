// ForemanError: every refusal this module produces carries a `code` for
// callers that need to branch on it, and a `message` written to be shown
// to the Client verbatim.

export type ForemanErrorCode = "no-brain" | "invalid-attempts" | "missing-check" | "not-built";

export class ForemanError extends Error {
  readonly code: ForemanErrorCode;

  constructor(code: ForemanErrorCode, message: string) {
    super(message);
    this.name = "ForemanError";
    this.code = code;
  }
}
