// Parses the arguments after `fabrica watch` (SPEC.md: `fabrica watch
// <id>`) - one positional, nothing else, same refuse-with-exact-
// instructions style as log-args.ts and verdict-args.ts.

import { CliError } from "./errors.ts";

export const WATCH_USAGE = "fabrica watch <taskId>";

export interface WatchArgs {
  taskId: string;
}

export function parseWatchArgs(argv: string[]): WatchArgs {
  const positionals: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("-")) {
      throw new CliError("bad-usage", `fabrica watch: unknown flag "${arg}". Usage: ${WATCH_USAGE}`);
    }
    positionals.push(arg);
  }

  if (positionals.length === 0) {
    throw new CliError("bad-usage", `fabrica watch: missing <taskId>. Usage: ${WATCH_USAGE}`);
  }
  if (positionals.length > 1) {
    throw new CliError(
      "bad-usage",
      `fabrica watch: got ${positionals.length} positional arguments, expected just a taskId. Usage: ${WATCH_USAGE}`
    );
  }

  return { taskId: positionals[0] };
}
