// This module's one typed error. Everything here is a read of somebody
// else's service, so a failure is never fatal to a task: `poll.ts`
// catches these and turns them into a `ChecksReport` with verdict
// "unreadable" and this message as its `problem`. The message is written
// to be shown to the Client verbatim, like every other module's.

export type CiErrorCode =
  /** No GitHub token could be resolved, so nothing can be read at all. */
  | "no-token"
  /** The request never got an answer - DNS, a dropped connection, a
   * timeout on the request itself. */
  | "unreachable"
  /** An answer arrived and it was not a success - 401, 403, 404, 5xx. */
  | "refused"
  /** An answer arrived and was not the JSON shape the endpoint
   * documents. */
  | "malformed";

export class CiError extends Error {
  constructor(
    readonly code: CiErrorCode,
    message: string
  ) {
    super(message);
    this.name = "CiError";
  }
}
