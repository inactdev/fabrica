// ConfigError: every refusal this module produces carries a `code` for
// callers that need to branch on it, and a `message` written to be shown
// to the Client verbatim — it must always name exactly what to add.

export type ConfigErrorCode =
  | "not-found"
  | "malformed"
  | "unregistered-project"
  | "missing-check";

export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  /**
   * The 1-based line in projects.toml the problem sits on, when the
   * failure is the TOML parse itself and the parser said where. Null for
   * every other refusal: a file that parsed fine but names an unknown
   * key, or a cap that isn't a number, has no single line the way a
   * syntax error does — the message names the table and field instead.
   *
   * Callers that re-print this (`fabrica doctor`, `fabrica status`, the
   * live view's banner) read it off `message`, which already carries it;
   * this field is for anything that needs the number on its own.
   */
  readonly line: number | null;

  constructor(code: ConfigErrorCode, message: string, line: number | null = null) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
    this.line = line;
  }
}
