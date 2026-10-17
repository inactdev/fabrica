// Parses the arguments after `fabrica do` (SPEC.md: `fabrica do "<task
// text>" --project <path-or-name>`). One positional (the task text,
// quoted by the caller's shell) and one required flag; every wrong shape
// refuses with exact instructions, matching src/config's style.

import { CliError } from "./errors.ts";

export const DO_USAGE = 'fabrica do "<task text>" --project <path-or-name> [--issue <N>]';

export interface DoArgs {
  taskText: string;
  projectArg: string;
  /** The issue number the chat agent names explicitly - the alternative
   * to the task text itself starting with "Issue #N:" (see
   * src/foreman/pr-body.ts's `closesIssueFor`). Omitted, nothing about
   * closing an issue is added unless the task text names one itself. */
  issue?: number;
}

export function parseDoArgs(argv: string[]): DoArgs {
  let projectArg: string | undefined;
  let issueArg: string | undefined;
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
    } else if (arg === "--issue") {
      const value = argv[++i];
      if (value === undefined) {
        throw new CliError("bad-usage", `fabrica do: --issue needs a value. Usage: ${DO_USAGE}`);
      }
      issueArg = value;
    } else if (arg.startsWith("--issue=")) {
      issueArg = arg.slice("--issue=".length);
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

  let issue: number | undefined;
  if (issueArg !== undefined) {
    issue = Number(issueArg);
    if (!Number.isInteger(issue) || issue < 1) {
      throw new CliError(
        "bad-usage",
        `fabrica do: --issue must be a positive integer, got "${issueArg}". Usage: ${DO_USAGE}`
      );
    }
  }

  return { taskText: positionals[0], projectArg, ...(issue !== undefined ? { issue } : {}) };
}
