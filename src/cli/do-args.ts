// Parses the arguments after `fabrica do` (SPEC.md: `fabrica do "<task
// text>" --project <path-or-name>`). One positional (the task text,
// quoted by the caller's shell) and one required flag; every wrong shape
// refuses with exact instructions, matching src/config's style.

import { isAbsolute, resolve } from "node:path";
import { ISSUE_ARG_FORMS, parseIssueArg } from "../index.ts";
import type { IssueRequest } from "../index.ts";
import { CliError } from "./errors.ts";

export const DO_USAGE =
  'fabrica do "<task text>" --project <path-or-name> [--issue <N>] [--model <name>] [--file <path>]...';

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
  /** The model this one task asks for (issue #184), overriding the
   * project's own `model` in projects.toml. Omitted, the project's
   * setting decides, and without one the worker's own configuration
   * does. */
  model?: string;
  /** The files this task is handed (issue #325), as absolute paths, in
   * the order `--file` named them. Made absolute here rather than at
   * registration because the task's own loop runs in a detached process
   * with its own working directory: a relative path would mean one thing
   * on this terminal and another there. Omitted when `--file` was not
   * used at all; whether a path has a readable file at it is settled at
   * registration, where a refusal lands on the task's own record
   * (src/foreman/task-files.ts). */
  files?: string[];
}

export function parseDoArgs(argv: string[]): DoArgs {
  let projectArg: string | undefined;
  let issueArg: string | undefined;
  let modelArg: string | undefined;
  const fileArgs: string[] = [];
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
    } else if (arg === "--model") {
      const value = argv[++i];
      if (value === undefined) {
        throw new CliError("bad-usage", `fabrica do: --model needs a value. Usage: ${DO_USAGE}`);
      }
      modelArg = value;
    } else if (arg.startsWith("--model=")) {
      modelArg = arg.slice("--model=".length);
    } else if (arg === "--file") {
      const value = argv[++i];
      if (value === undefined) {
        throw new CliError("bad-usage", `fabrica do: --file needs a value. Usage: ${DO_USAGE}`);
      }
      fileArgs.push(value);
    } else if (arg.startsWith("--file=")) {
      fileArgs.push(arg.slice("--file=".length));
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

  // A `--model` with nothing but whitespace behind it is refused rather
  // than quietly dropped: the Client asking for a model and silently
  // getting the default one is exactly the confusion this flag exists
  // to end.
  let model: string | undefined;
  if (modelArg !== undefined) {
    model = modelArg.trim();
    if (model.length === 0) {
      throw new CliError("bad-usage", `fabrica do: --model needs a model name. Usage: ${DO_USAGE}`);
    }
  }

  // Refused rather than quietly dropped, for the same reason an empty
  // `--model` is: the Client handing a task a document and the task
  // silently never receiving it is exactly the confusion this flag
  // exists to end. Only the value's own shape is judged here - whether
  // there is a readable file at the path is settled at registration,
  // where the refusal can land on the task's own record.
  const files: string[] = [];
  for (const named of fileArgs) {
    const trimmed = named.trim();
    if (trimmed.length === 0) {
      throw new CliError("bad-usage", `fabrica do: --file needs a path. Usage: ${DO_USAGE}`);
    }
    files.push(isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed));
  }

  return {
    taskText: positionals[0],
    projectArg,
    ...(issue !== undefined ? { issue } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(files.length > 0 ? { files } : {}),
  };
}
