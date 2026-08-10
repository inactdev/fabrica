// Parses the arguments after `fabrica log` (SPEC.md: `fabrica log <id>`,
// `--transcript` includes the raw agent output) - one positional and one
// flag, same refuse-with-exact-instructions style as verdict-args.ts.

import { CliError } from "./errors.ts";

export const LOG_USAGE = "fabrica log <taskId> [--transcript]";

export interface LogArgs {
  taskId: string;
  transcript: boolean;
}

export function parseLogArgs(argv: string[]): LogArgs {
  let transcript = false;
  const positionals: string[] = [];

  for (const arg of argv) {
    if (arg === "--transcript") {
      transcript = true;
    } else if (arg.startsWith("-")) {
      throw new CliError("bad-usage", `fabrica log: unknown flag "${arg}". Usage: ${LOG_USAGE}`);
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length === 0) {
    throw new CliError("bad-usage", `fabrica log: missing <taskId>. Usage: ${LOG_USAGE}`);
  }
  if (positionals.length > 1) {
    throw new CliError(
      "bad-usage",
      `fabrica log: got ${positionals.length} positional arguments, expected just a taskId. Usage: ${LOG_USAGE}`
    );
  }

  return { taskId: positionals[0], transcript };
}
