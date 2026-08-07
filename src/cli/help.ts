// The top-level `fabrica --help` text and command registration. New
// subcommands (status/log/watch #12) slot in as one more line in
// COMMANDS and one more entry in this help text - nothing here needs
// reshaping to add them.

export const COMMANDS = ["do", "verdict", "answer", "status", "log", "watch"] as const;

export const TOP_LEVEL_HELP = `fabrica - hand in a task; get it done in isolation, verified, honestly.

Usage: fabrica <command> [args]

Commands:
  do "<task text>" --project <path-or-name>
      Run a task against a project. If it's materially ambiguous, prints
      numbered questions and stops - answer with \`fabrica answer\`.
      Otherwise runs detached: prints the task id and returns immediately.
  answer <taskId> -m "<text>"
      Answer a task's clarifying questions and resume it.
  verdict <taskId> <accept|fix|wrong> [-m "<note>"]
      Record your ruling on a delivered task - closes it (accept/wrong)
      or sends a correction back to the same worker (fix).
  status
      One line per open task: id, project, state, age. Flags a
      delivered task as awaiting your verdict.
  log <taskId> [--transcript]
      Print one task's full event history; --transcript adds the raw
      agent output.
  watch <taskId>
      Follow a task while it runs: heartbeats live, transcript in
      batches. Stopping this (Ctrl-C) never stops the work.

Run "fabrica <command> --help" for a command's own usage.
`;
