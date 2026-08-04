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

  constructor(code: ConfigErrorCode, message: string) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}
