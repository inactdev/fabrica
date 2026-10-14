// `fabrica await <id>`: waits until the task needs the Client - delivered,
// asked a question, or failed - then exits, printing exactly one line
// naming which and what to do about it. Never exits for a heartbeat or
// any other event along the way (HANDBOOK.md's case 1 runs this as a
// background command precisely so the assistant learns the moment one of
// those three happens, without polling `fabrica status` itself).
//
// Same read-only polling discipline as `fabrica watch`: this process only
// ever reads the record (events.jsonl, via the same followTask a poll
// never re-reads in full) and never touches the detached worker, so there
// is nothing here that could affect the task even if it wanted to.

import { followTask, stateOf } from "../index.ts";
import { CliError } from "./errors.ts";
import { delay } from "./delay.ts";
import { AWAIT_USAGE, parseAwaitArgs } from "./await-args.ts";
import { resolveRecordHome } from "./record-home.ts";
import type { FabricaTask } from "../index.ts";

export const AWAIT_HELP = `Usage: ${AWAIT_USAGE}

Waits until the task needs you - delivered, asking a clarifying
question, or failed - then exits, printing exactly one line naming
which and what to do about it:

  <id> delivered - awaiting your verdict
  <id> asked a question - answer with fabrica answer <id>
  <id> failed - see fabrica log <id>

Never exits for a heartbeat or any other event along the way, and exits
immediately if the task is already in one of those states when it
starts.

  <taskId>   The task to await. See \`fabrica status\` for open ids.

Environment:
  FABRICA_HOME  Overrides the record home (default: ~/.fabrica).
`;

const DEFAULT_POLL_INTERVAL_MS = 500;

export interface RunAwaitCommandOptions {
  recordHome?: string;
  pollIntervalMs?: number;
  /** Aborting stops the poll loop and returns exit code 0 with nothing
   * printed - test-only, since real use waits for one of the three
   * states rather than being cancelled. */
  signal?: AbortSignal;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

type AwaitableState = "delivered" | "asking" | "failed";

function noticeFor(taskId: string, state: AwaitableState): string {
  switch (state) {
    case "delivered":
      return `${taskId} delivered - awaiting your verdict`;
    case "asking":
      return `${taskId} asked a question - answer with fabrica answer ${taskId}`;
    case "failed":
      return `${taskId} failed - see fabrica log ${taskId}`;
  }
}

function awaitableStateOf(state: FabricaTask["state"]): AwaitableState | null {
  return state === "delivered" || state === "asking" || state === "failed" ? state : null;
}

/** Returns the process exit code - never throws. */
export async function runAwaitCommand(argv: string[], opts: RunAwaitCommandOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? ((line: string) => console.log(line));
  const stderr = opts.stderr ?? ((line: string) => console.error(line));

  try {
    const { taskId } = parseAwaitArgs(argv);
    const recordHome = opts.recordHome ?? resolveRecordHome();
    const follower = followTask(recordHome, taskId);

    if (follower.read().events.length === 0) {
      throw new CliError(
        "unknown-task",
        `fabrica await: no task "${taskId}" in this record. Check the id with \`fabrica status\`.`
      );
    }

    const signal = opts.signal;
    const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    while (true) {
      const { events } = follower.read();
      const awaitable = awaitableStateOf(stateOf(events));
      if (awaitable) {
        stdout(noticeFor(taskId, awaitable));
        return 0;
      }
      if (signal?.aborted) return 0;
      await delay(pollIntervalMs, signal ?? new AbortController().signal);
      if (signal?.aborted) return 0;
    }
  } catch (err) {
    stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
