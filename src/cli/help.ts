// The top-level `fabrica --help` text and command registration. New
// subcommands (fabrica answer #8, verdict #10, status/log/watch #12)
// slot in as one more line in COMMANDS and one more entry in this help
// text - nothing here needs reshaping to add them.

export const COMMANDS = ["do"] as const;

export const TOP_LEVEL_HELP = `fabrica - hand in a task; get it done in isolation, verified, honestly.

Usage: fabrica <command> [args]

Commands:
  do "<task text>" --project <path-or-name>
      Run a task against a project, detached. Prints the task id and
      returns immediately.

Run "fabrica <command> --help" for a command's own usage.
`;
