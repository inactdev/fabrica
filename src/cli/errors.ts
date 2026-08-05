// CliError: refusals owned by the CLI layer itself - bad invocations,
// an unresolvable --project, a task that never registered. Every message
// is written to be shown to the Client verbatim, matching src/config's
// exact-instructions style (name the problem, say precisely what to do
// instead). Errors from lower layers (ConfigError, ForemanError) are
// shown by printing their own .message directly - they already speak
// this same style, so nothing here wraps them.

export type CliErrorCode =
  | "bad-usage"
  | "unknown-command"
  | "project-not-found"
  | "spawn-failed"
  | "registration-timeout";

export class CliError extends Error {
  readonly code: CliErrorCode;

  constructor(code: CliErrorCode, message: string) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}
