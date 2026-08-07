// LineError: every refusal this module produces carries a `code` for
// callers that need to branch on it, and a `message` written to be shown
// to the Client verbatim.

export type LineErrorCode =
  | "invalid-id"
  | "home-not-found"
  | "not-a-repo"
  | "workdir-exists"
  | "cut-failed"
  | "no-such-branch"
  | "unsafe-teardown"
  | "teardown-failed"
  | "not-a-worktree"
  | "unsanitizable-config";

export class LineError extends Error {
  readonly code: LineErrorCode;

  constructor(code: LineErrorCode, message: string) {
    super(message);
    this.name = "LineError";
    this.code = code;
  }
}
