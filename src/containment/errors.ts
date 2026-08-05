// ContainmentError: every refusal this module produces carries a `code`
// for callers that need to branch on it, and a `message` written to be
// shown to the Client verbatim.

export type ContainmentErrorCode = "unsupported-platform" | "invalid-path" | "spawn-failed";

export class ContainmentError extends Error {
  readonly code: ContainmentErrorCode;

  constructor(code: ContainmentErrorCode, message: string) {
    super(message);
    this.name = "ContainmentError";
    this.code = code;
  }
}
