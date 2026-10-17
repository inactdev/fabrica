// @ts-check
// RelayError: every refusal this module produces carries a `code` for
// callers that need to branch on it, and a `message` written to be shown
// to the Client verbatim.
//
// Plain JavaScript, not TypeScript: this file is loaded inside the relay
// container by a stock `node` with nothing from node_modules (see
// container/bootstrap.mjs). The JSDoc types are only for `tsc`.

/** @typedef {"invalid-config" | "listen-failed"} RelayErrorCode */

export class RelayError extends Error {
  /**
   * @param {RelayErrorCode} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "RelayError";
    /** @readonly */
    this.code = code;
  }
}
