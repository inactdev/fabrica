// RecordError: every refusal this module produces carries a `code` for
// callers that need to branch on it, and a `message` written to be shown
// to the Client verbatim.

export type RecordErrorCode = "id-exhausted";

export class RecordError extends Error {
  readonly code: RecordErrorCode;

  constructor(code: RecordErrorCode, message: string) {
    super(message);
    this.name = "RecordError";
    this.code = code;
  }
}
