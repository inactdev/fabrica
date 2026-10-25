// GithubAppError: every refusal this module produces carries a `code`
// for callers that need to branch on it, and a `message` written to be
// shown to the Client verbatim - the setup step he has to take, named,
// rather than a status code he has to interpret.
//
// No message here ever carries the App's private key or a minted token.
// The only secrets this module handles are a PEM on disk and a token in
// flight, and a refusal naming either would put it on the record (a
// `task-failed` event's own details) and in the Client's terminal.

export type GithubAppErrorCode =
  /** Neither the App id nor the key path is configured - the state every
   * machine starts in, and the one the setup instructions answer. */
  | "app-not-configured"
  /** One of the two is configured and the other is not, which is never
   * a working state and is always worth saying out loud. */
  | "app-half-configured"
  /** The key path names a file that could not be read at all. */
  | "app-key-unreadable"
  /** The key file's mode is not 600 (Client ruling: any other mode is
   * refused by name). */
  | "app-key-permissions"
  /** The file was read, but is not a private key this machine can sign
   * with. */
  | "app-key-invalid"
  /** The App is not installed on the repository a token was asked for -
   * GitHub answers 404 to the installation lookup, which is the same
   * status it gives for a repository the App cannot see at all. */
  | "app-not-installed"
  /** GitHub answered, but refused to mint: a revoked key (401), an
   * installation that may not grant a permission that was asked for
   * (403/422), anything else outside 2xx. */
  | "mint-refused"
  /** GitHub could not be reached, or answered something that was not
   * the documented JSON. */
  | "mint-unreachable";

export class GithubAppError extends Error {
  readonly code: GithubAppErrorCode;

  constructor(code: GithubAppErrorCode, message: string) {
    super(message);
    this.name = "GithubAppError";
    this.code = code;
  }
}
