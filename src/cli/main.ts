// Top-level dispatch: `fabrica <command> [args]`. This is the whole
// command registration issue #47 asks for - #8's `answer` added one more
// `if (command === "...")` branch below and its own args/help module,
// without touching how `do`, `verdict`, or `--help` already work; #12
// (status/log/watch) will do the same.

import { DO_HELP, runDoCommand } from "./do-command.ts";
import { VERDICT_HELP, runVerdictCommand } from "./verdict-command.ts";
import { ANSWER_HELP, runAnswerCommand } from "./answer-command.ts";
import { TOP_LEVEL_HELP } from "./help.ts";

export async function main(
  argv: string[],
  io: { stdout: (line: string) => void; stderr: (line: string) => void } = {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  }
): Promise<number> {
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

  io.stderr(`fabrica: unknown command "${command}".\n\n${TOP_LEVEL_HELP}`);
  return 1;
}
