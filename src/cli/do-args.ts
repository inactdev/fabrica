// Parses the arguments after `fabrica do` (SPEC.md: `fabrica do "<task
// text>" --project <path-or-name>`). One positional (the task text,
// quoted by the caller's shell) and one required flag; every wrong shape
// refuses with exact instructions, matching src/config's style.

import { ISSUE_ARG_FORMS, parseIssueArg } from "../index.ts";
import type { IssueRequest } from "../index.ts";
import { CliError } from "./errors.ts";

export const DO_USAGE = 'fabrica do "<task text>" --project <path-or-name> [--issue <N>]';

export interface DoArgs {
  taskText: string;
  projectArg: string;
  /** The issue the chat agent names explicitly - the alternative to the
   * task text itself starting with "Issue #N:" (see
   * src/foreman/pr-body.ts's `closesIssueFor`). A number for the
   * project's own repository; the `owner/repo#N` and issue-URL
   * spellings are kept as text and resolved at registration, where the
   * project's origin remote is known (src/foreman/task-issue.ts).
   * Omitted, nothing is fetched and nothing about closing an issue is
   * added unless the task text names one itself. */
  issue?: number | string;
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

  // Parsed here only to refuse a typo in the foreground, before a
  // detached process is spawned for it - src/github owns the spellings,
  // so the CLI and the registration step can never disagree about which
  // values are legal. A plain number is handed on as a number, the one
  // form `Foreman.do`'s ratified `issue` option names; the two
  // repository-naming spellings travel as the text the Client typed and
  // are resolved at registration, where the project's origin is known.
  let issue: number | string | undefined;
  if (issueArg !== undefined) {
    let parsed: IssueRequest;
    try {
      parsed = parseIssueArg(issueArg);
    } catch {
      throw new CliError(
        "bad-usage",
        `fabrica do: --issue must be ${ISSUE_ARG_FORMS}, got "${issueArg}". Usage: ${DO_USAGE}`
      );
    }
    issue = parsed.repo === undefined ? parsed.number : issueArg;
  }

  return { taskText: positionals[0], projectArg, ...(issue !== undefined ? { issue } : {}) };
}
