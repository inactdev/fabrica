// TestMapError: every refusal this module produces carries a `code` for
// callers that need to branch on it, and a `message` written to be shown
// to the Client verbatim - it always names the file and the line the
// problem is on, because the fix is always an edit to one line of
// `tests.map`.

export type TestMapErrorCode =
  /** A line of `tests.map` is not `pattern: tests` - no colon, an empty
   * pattern, or an empty test list. Nothing is guessed from it: a map
   * Fabrica cannot read is a map that would silently stop naming tests,
   * which is the one outcome this whole feature exists to prevent. */
  "malformed-test-map";

export class TestMapError extends Error {
  readonly code: TestMapErrorCode;

  constructor(code: TestMapErrorCode, message: string) {
    super(message);
    this.name = "TestMapError";
    this.code = code;
  }
}
