// DeliveryError: every rejection this module produces carries a `code` for
// callers that need to branch on it, and a `message` written to be shown
// to the Client verbatim.

export type DeliveryErrorCode = "malformed" | "files-mismatch" | "branch-unreadable";

export class DeliveryError extends Error {
  readonly code: DeliveryErrorCode;

  constructor(code: DeliveryErrorCode, message: string) {
    super(message);
    this.name = "DeliveryError";
    this.code = code;
  }
}
