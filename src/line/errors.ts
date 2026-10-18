// LineError: every refusal this module produces carries a `code` for
// callers that need to branch on it, and a `message` written to be shown
// to the Client verbatim.

export type LineErrorCode =
  | "invalid-id"
  | "home-not-found"
  | "not-a-repo"
  | "workdir-exists"
  | "fetch-failed"
  | "cut-failed"
  | "no-such-branch"
  | "unsafe-teardown"
  | "teardown-failed"
  | "not-a-worktree"
  | "unsanitizable-config"
  /** A rebase was asked for against a path git does not hold as this
   * line's own worktree on this line's own branch, or one that already
   * has a rebase in flight (issue #235, src/line/rebase.ts). */
  | "unsafe-rebase"
  /** A rebase (or its abort/continue) failed for a reason that is not a
   * conflict - a conflict is a result there, never an error. */
  | "rebase-failed";

export class LineError extends Error {
  readonly code: LineErrorCode;

  constructor(code: LineErrorCode, message: string) {
    super(message);
    this.name = "LineError";
    this.code = code;
  }
}
