// Parses the arguments after `fabrica do` (SPEC.md: `fabrica do "<task
// text>" --project <path-or-name>`). One positional (the task text,
// quoted by the caller's shell) and one required flag; every wrong shape
// refuses with exact instructions, matching src/config's style.

import { CliError } from "./errors.ts";

export const DO_USAGE = 'fabrica do "<task text>" --project <path-or-name>';

export interface DoArgs {
  taskText: string;
  projectArg: string;
}

export function parseDoArgs(argv: string[]): DoArgs {
  let projectArg: string | undefined;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project") {
      const value = argv[++i];
      if (value === undefined) {
        throw new CliError("bad-usage", `fabrica do: --project needs a value. Usage: ${DO_USAGE}`);
      }
      projectArg = value;
    } else if (arg.startsWith("--project=")) {
      projectArg = arg.slice("--project=".length);
    } else if (arg.startsWith("-")) {
      throw new CliError(
        "bad-usage",
        `fabrica do: unknown flag "${arg}". Usage: ${DO_USAGE}`
      );
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length === 0) {
    throw new CliError(
      "bad-usage",
      `fabrica do: missing "<task text>". Usage: ${DO_USAGE}`
    );
  }
  if (positionals.length > 1) {
    throw new CliError(
      "bad-usage",
      `fabrica do: got ${positionals.length} positional arguments, expected one task text. ` +
        `Wrap it in quotes: ${DO_USAGE}`
    );
  }
  if (projectArg === undefined || projectArg.trim().length === 0) {
    throw new CliError(
      "bad-usage",
      `fabrica do: missing --project <path-or-name>. Usage: ${DO_USAGE}`
    );
  }

  return { taskText: positionals[0], projectArg };
}
