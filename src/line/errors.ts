// LineError: every refusal this module produces carries a `code` for
// callers that need to branch on it, and a `message` written to be shown
// to the Client verbatim.

export type LineErrorCode =
  | "invalid-id"
  | "home-not-found"
  | "not-a-repo"
  | "workdir-exists"
  | "cut-failed"
  | "unsafe-teardown"
  | "teardown-failed";

export class LineError extends Error {
  readonly code: LineErrorCode;

  constructor(code: LineErrorCode, message: string) {
    super(message);
    this.name = "LineError";
    this.code = code;
  }
}
