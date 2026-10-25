// Parses the arguments after `fabrica tests-map`. One optional
// positional (the project folder, defaulting to the current directory,
// the same shape `fabrica register <path>` takes) and one flag. Every
// wrong shape refuses with exact instructions, matching src/config's
// style.

import { CliError } from "./errors.ts";

export const TESTS_MAP_USAGE = "fabrica tests-map [<path>] [--force]";

export interface TestsMapArgs {
  /** The project folder, as typed - resolved against the process's cwd
   * by the command itself. "." when none was given. */
  pathArg: string;
  /** Overwrite an existing `tests.map`. Off by default: the file is
   * meant to be hand-edited after it is generated, so replacing one
   * wholesale has to be asked for. */
  force: boolean;
}

export function parseTestsMapArgs(argv: string[]): TestsMapArgs {
  let force = false;
  const positionals: string[] = [];

  for (const arg of argv) {
    if (arg === "--force" || arg === "-f") {
      force = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new CliError("bad-usage", `fabrica tests-map: unknown flag "${arg}". Usage: ${TESTS_MAP_USAGE}`);
    }
    positionals.push(arg);
  }

  if (positionals.length > 1) {
    throw new CliError(
      "bad-usage",
      `fabrica tests-map: expected one path, got ${positionals.length} ` +
        `(${positionals.map((value) => `"${value}"`).join(", ")}). Usage: ${TESTS_MAP_USAGE}`
    );
  }

  return { pathArg: positionals[0] ?? ".", force };
}
