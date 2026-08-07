// Top-level dispatch: `fabrica <command> [args]`. This is the whole
// command registration issue #47 asks for - #8's `answer` added one more
// `if (command === "...")` branch below and its own args/help module,
// without touching how `do`, `verdict`, or `--help` already work; #12
// (status/log/watch) will do the same.

import { checkForOffBooksChanges } from "../index.ts";
import { DO_HELP, runDoCommand } from "./do-command.ts";
import { VERDICT_HELP, runVerdictCommand } from "./verdict-command.ts";
import { ANSWER_HELP, runAnswerCommand } from "./answer-command.ts";
import { STATUS_HELP, runStatusCommand } from "./status-command.ts";
import { LOG_HELP, runLogCommand } from "./log-command.ts";
import { WATCH_HELP, runWatchCommand } from "./watch-command.ts";
import { TOP_LEVEL_HELP } from "./help.ts";
import { resolveRecordHome } from "./record-home.ts";

export async function main(
  argv: string[],
  io: { stdout: (line: string) => void; stderr: (line: string) => void } = {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  },
  opts: { recordHome?: string } = {}
): Promise<number> {
  // SPEC.md "Catching off-the-books work": every command run checks the
  // registered projects for changes no task explains. A courtesy, never
  // a gate — checkForOffBooksChanges swallows its own failures, so this
  // can never stop a command from running.
  checkForOffBooksChanges(opts.recordHome ?? resolveRecordHome());

  const [command, ...rest] = argv;

  if (command === undefined) {
    io.stderr(TOP_LEVEL_HELP);
    return 1;
  }
  if (command === "--help" || command === "-h") {
    io.stdout(TOP_LEVEL_HELP);
    return 0;
  }

  if (command === "do") {
    if (rest.includes("--help") || rest.includes("-h")) {
      io.stdout(DO_HELP);
      return 0;
    }
    return runDoCommand(rest, io);
  }

  if (command === "verdict") {
    if (rest.includes("--help") || rest.includes("-h")) {
      io.stdout(VERDICT_HELP);
      return 0;
    }
    return runVerdictCommand(rest, io);
  }

  if (command === "answer") {
    if (rest.includes("--help") || rest.includes("-h")) {
      io.stdout(ANSWER_HELP);
      return 0;
    }
    return runAnswerCommand(rest, io);
  }

  if (command === "status") {
    if (rest.includes("--help") || rest.includes("-h")) {
      io.stdout(STATUS_HELP);
      return 0;
    }
    return runStatusCommand(rest, io);
  }

  if (command === "log") {
    if (rest.includes("--help") || rest.includes("-h")) {
      io.stdout(LOG_HELP);
      return 0;
    }
    return runLogCommand(rest, io);
  }

  if (command === "watch") {
    if (rest.includes("--help") || rest.includes("-h")) {
      io.stdout(WATCH_HELP);
      return 0;
    }
    return runWatchCommand(rest, io);
  }

  io.stderr(`fabrica: unknown command "${command}".\n\n${TOP_LEVEL_HELP}`);
  return 1;
}
