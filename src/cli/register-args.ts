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

import { CliError } from "./errors.ts";

export const REGISTER_USAGE =
  'fabrica register <path> --check "<command>" --image <docker image> [--network] ' +
  "[--timeout <seconds>] [--protected <glob,...>] [--name <name>]";

export interface RegisterArgs {
  path: string;
  check?: string;
  image?: string;
  /** Split from a comma-separated --protected list, trimmed, empties
   * dropped. */
  protectedPaths: string[];
  name?: string;
  /** Present only when --network was passed: off is the absence of the
   * flag, and of the .inspector.json key it writes. */
  network?: boolean;
  timeoutSeconds?: number;
}

const VALUE_FLAGS = ["--check", "--image", "--protected", "--name", "--timeout"] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

/** Flags that take no value at all. */
const BARE_FLAGS = ["--network"] as const;

export function parseRegisterArgs(argv: string[]): RegisterArgs {
  const values: Partial<Record<ValueFlag, string>> = {};
  const positionals: string[] = [];
  let network = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const bare = BARE_FLAGS.find((flag) => arg === flag);
    if (bare !== undefined) {
      network = true;
      continue;
    }
    // Caught separately from "unknown flag", because `--network=true` is
    // a reasonable guess at a flag that genuinely takes no value, and
    // there is no spelling of "off" to offer in its place.
    const bareWithValue = BARE_FLAGS.find((flag) => arg.startsWith(`${flag}=`));
    if (bareWithValue !== undefined) {
      throw new CliError(
        "bad-usage",
        `fabrica register: ${bareWithValue} takes no value - pass it to allow the check network access, or ` +
          `leave it out to deny it. Usage: ${REGISTER_USAGE}`
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

  for (const flag of ["--check", "--image", "--name"] as const) {
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
    ...(network ? { network: true } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
  };
}
