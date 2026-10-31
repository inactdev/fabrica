// Parses the arguments after `fabrica register`. One positional (the
// repository's path) and six flags; every wrong shape refuses with
// exact instructions, matching do-args.ts's style.
//
// --check and --image are deliberately not required here even though the
// usage line names them: whether they are needed depends on something
// only the repository can answer (does origin's default branch already
// carry .inspector.json?), and asking git that from an argument parser
// would be the wrong place for it. src/register/register.ts requires
// them at the point it knows, and says why.
//
// --terms being incompatible with four of the others is refused there
// too, for a different reason: `registerProject` is also a library
// entry point (src/index.ts), and one implementation of that rule means
// the library and the command can never come to disagree about it.

import { CliError } from "./errors.ts";

export const REGISTER_USAGE =
  'fabrica register <path> --check "<command>" --image <docker image> ' +
  "[--timeout <seconds>] [--protected <glob,...>] [--name <name>]\n" +
  "       fabrica register <path> --terms <folder> [--name <name>]";

export interface RegisterArgs {
  path: string;
  check?: string;
  image?: string;
  /** Split from a comma-separated --protected list, trimmed, empties
   * dropped. */
  protectedPaths: string[];
  name?: string;
  timeoutSeconds?: number;
  /** `--terms <folder>`: a work-mode project, whose three files go into
   * this folder instead of into the repository. */
  terms?: string;
}

const VALUE_FLAGS = ["--check", "--image", "--protected", "--name", "--timeout", "--terms"] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

/**
 * Flags this command used to accept, and what to say instead. `--network`
 * is gone outright since inspector#47 (issue #303, Client ruling): the
 * check box has no network, with no key left to ask for one, so the
 * refusal has to say where dependencies go now rather than only that the
 * flag is unknown - "unknown flag" alone would read as a typo.
 */
const RETIRED_FLAGS: Record<string, string> = {
  "--network": `The check box has no network at all any more, and nothing can ask for one: a project's own ` +
    `dependencies are installed in Dockerfile.inspector, at build time, which register writes for you.`,
};

export function parseRegisterArgs(argv: string[]): RegisterArgs {
  const values: Partial<Record<ValueFlag, string>> = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const retired = Object.keys(RETIRED_FLAGS).find((flag) => arg === flag || arg.startsWith(`${flag}=`));
    if (retired !== undefined) {
      throw new CliError(
        "bad-usage",
        `fabrica register: unknown flag "${retired}". ${RETIRED_FLAGS[retired]} Usage: ${REGISTER_USAGE}`
      );
    }
    const matched = VALUE_FLAGS.find((flag) => arg === flag || arg.startsWith(`${flag}=`));
    if (matched !== undefined) {
      if (arg === matched) {
        const value = argv[++i];
        if (value === undefined) {
          throw new CliError("bad-usage", `fabrica register: ${matched} needs a value. Usage: ${REGISTER_USAGE}`);
        }
        values[matched] = value;
      } else {
        values[matched] = arg.slice(matched.length + 1);
      }
      continue;
    }
    if (arg.startsWith("-")) {
      throw new CliError("bad-usage", `fabrica register: unknown flag "${arg}". Usage: ${REGISTER_USAGE}`);
    }
    positionals.push(arg);
  }

  if (positionals.length === 0) {
    throw new CliError("bad-usage", `fabrica register: missing <path>. Usage: ${REGISTER_USAGE}`);
  }
  if (positionals.length > 1) {
    throw new CliError(
      "bad-usage",
      `fabrica register: got ${positionals.length} positional arguments, expected one path. Usage: ${REGISTER_USAGE}`
    );
  }

  for (const flag of ["--check", "--image", "--name", "--terms"] as const) {
    const value = values[flag];
    if (value !== undefined && value.trim().length === 0) {
      throw new CliError("bad-usage", `fabrica register: ${flag} was given an empty value. Usage: ${REGISTER_USAGE}`);
    }
  }

  // A whole number of seconds, and a real one: `--timeout 0` would be a
  // check given no time to run, and `--timeout 10m` is a spelling
  // .inspector.json's own `timeoutSeconds` has no way to carry.
  const rawTimeout = values["--timeout"];
  let timeoutSeconds: number | undefined;
  if (rawTimeout !== undefined) {
    if (!/^\d+$/.test(rawTimeout.trim()) || Number(rawTimeout.trim()) === 0) {
      throw new CliError(
        "bad-usage",
        `fabrica register: --timeout takes a whole number of seconds greater than zero, not "${rawTimeout}". ` +
          `Usage: ${REGISTER_USAGE}`
      );
    }
    timeoutSeconds = Number(rawTimeout.trim());
  }

  const protectedPaths = (values["--protected"] ?? "")
    .split(",")
    .map((glob) => glob.trim())
    .filter((glob) => glob.length > 0);

  return {
    path: positionals[0],
    ...(values["--check"] !== undefined ? { check: values["--check"] } : {}),
    ...(values["--image"] !== undefined ? { image: values["--image"] } : {}),
    protectedPaths,
    ...(values["--name"] !== undefined ? { name: values["--name"] } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    ...(values["--terms"] !== undefined ? { terms: values["--terms"] } : {}),
  };
}
