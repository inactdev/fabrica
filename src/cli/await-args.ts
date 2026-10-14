// Parses the arguments after `fabrica await` - one positional, nothing
// else, same refuse-with-exact-instructions style as watch-args.ts (which
// this mirrors exactly: `fabrica await <id>` takes only a taskId).

import { CliError } from "./errors.ts";

export const AWAIT_USAGE = "fabrica await <taskId>";

export interface AwaitArgs {
  taskId: string;
}

export function parseAwaitArgs(argv: string[]): AwaitArgs {
  const positionals: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("-")) {
      throw new CliError("bad-usage", `fabrica await: unknown flag "${arg}". Usage: ${AWAIT_USAGE}`);
    }
    positionals.push(arg);
  }

  if (positionals.length === 0) {
    throw new CliError("bad-usage", `fabrica await: missing <taskId>. Usage: ${AWAIT_USAGE}`);
  }
  if (positionals.length > 1) {
    throw new CliError(
      "bad-usage",
      `fabrica await: got ${positionals.length} positional arguments, expected just a taskId. Usage: ${AWAIT_USAGE}`
    );
  }

  return { taskId: positionals[0] };
}
