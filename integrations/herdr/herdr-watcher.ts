// A Herdr integration that lives outside Fabrica's core (issue #125):
// for every task Fabrica receives, open a pane that runs `fabrica watch
// <id>` for it, and keep that pane's reported agent state in step with
// the task's own record. This file only ever reads the record
// (events.jsonl, request.md) through the same tail reader and task-file
// reader `fabrica watch` itself reads through (src/index.ts's
// createLineTail/recordPath/readTaskFile) - it never touches a running
// task's process, the same way `fabrica watch` never does.
//
// The pane/row/report_agent calls below assume a minimal external CLI
// shape (`<bin> pane split|run|name|report_agent ...`) - the real
// product (https://herdr.dev) is a reserved package with no shipped API
// yet, so this is the smallest shape the issue's own wording describes.
// Only `callHerdr`'s four one-line wrappers would need to change if the
// real CLI's shape differs; everything else here only depends on them.

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLineTail, readTaskFile, recordPath } from "../../src/index.ts";
import type { FabricaEvent } from "../../src/index.ts";

type AgentState = "working" | "blocked" | "done";

const TITLE_MAX_LENGTH = 60;

function resolveHerdrBin(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env.HERDR_BIN;
  if (override !== undefined && override.trim().length > 0) return override.trim().split(/\s+/);
  return ["herdr"];
}

function callHerdr(bin: string[], args: string[]): string {
  return execFileSync(bin[0], [...bin.slice(1), ...args], { encoding: "utf8" });
}

function splitPane(bin: string[]): string {
  return callHerdr(bin, ["pane", "split"]).trim();
}

function runInPane(bin: string[], paneId: string, command: string): void {
  callHerdr(bin, ["pane", "run", paneId, command]);
}

function namePane(bin: string[], paneId: string, name: string): void {
  callHerdr(bin, ["pane", "name", paneId, name]);
}

function reportAgent(bin: string[], paneId: string, state: AgentState): void {
  callHerdr(bin, ["pane", "report_agent", paneId, state]);
}

/** The task's title, for naming its pane's row - request.md verbatim,
 * trimmed to its first non-blank line and capped, the same way a short
 * label is capped elsewhere in this project (final-message.ts's title).
 * Falls back to the task id itself if request.md isn't there yet (a
 * task this watcher is somehow seeing before its own registration, or a
 * test fixture that only wrote the event). */
function titleFor(recordHome: string, taskId: string): string {
  const request = readTaskFile(recordHome, taskId, "request.md");
  const firstLine = request
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return taskId;
  return firstLine.length > TITLE_MAX_LENGTH ? `${firstLine.slice(0, TITLE_MAX_LENGTH - 3)}...` : firstLine;
}

/** The report_agent state this event moves a task to, or null if this
 * event doesn't change it. Deliberately only the three states the
 * integration promises: working while heartbeats arrive, blocked on a
 * question or a delivery awaiting the Client's verdict, done once the
 * Client's verdict actually closes the task (rule 6: "accept"/"wrong"
 * close it; "fix" reopens the loop, which the next heartbeat already
 * reports as "working" again - no extra case needed here for that). */
function stateForEvent(event: FabricaEvent): AgentState | null {
  switch (event.name) {
    case "heartbeat":
      return "working";
    case "questions-asked":
    case "delivered":
      return "blocked";
    case "verdict-recorded": {
      const ruling = (event.details as { ruling?: string } | undefined)?.ruling;
      return ruling === "accept" || ruling === "wrong" ? "done" : null;
    }
    default:
      return null;
  }
}

export interface HerdrWatcher {
  /** Reads whatever landed on the record since the last call (or since
   * startup, for the first one) and reacts to it. Synchronous, like the
   * record module itself - every call it makes is a quick, blocking CLI
   * invocation, not a long-running one. */
  pollOnce(): void;
}

export interface CreateHerdrWatcherOptions {
  recordHome: string;
  herdrBin?: string[];
  /** The command run in each newly opened pane. Defaults to `fabrica
   * watch <id>`, carrying this watcher's own FABRICA_HOME along so the
   * pane watches the same record regardless of Herdr's own environment. */
  watchCommandFor?: (taskId: string) => string;
}

export function createHerdrWatcher(opts: CreateHerdrWatcherOptions): HerdrWatcher {
  const { recordHome } = opts;
  const bin = opts.herdrBin ?? resolveHerdrBin();
  const watchCommandFor =
    opts.watchCommandFor ?? ((taskId: string) => `FABRICA_HOME=${recordHome} fabrica watch ${taskId}`);
  const tail = createLineTail(recordPath(recordHome));
  const panes = new Map<string, string>();

  // Drain whatever is already on the record before this watcher ever
  // looks at it: this is a live follower, not a replay of history, so a
  // restart never reopens a pane for a task that was received, and
  // possibly long since closed, before this process started.
  tail();

  return {
    pollOnce() {
      for (const line of tail()) {
        const event = parseLine(line);
        if (!event) continue;

        if (event.name === "task-received") {
          const paneId = splitPane(bin);
          runInPane(bin, paneId, watchCommandFor(event.taskId));
          namePane(bin, paneId, titleFor(recordHome, event.taskId));
          panes.set(event.taskId, paneId);
          continue;
        }

        const state = stateForEvent(event);
        if (state === null) continue;
        const paneId = panes.get(event.taskId);
        if (paneId === undefined) continue; // not a task this watcher opened a pane for
        reportAgent(bin, paneId, state);
      }
    },
  };
}

function parseLine(line: string): FabricaEvent | null {
  if (line.length === 0) return null;
  try {
    return JSON.parse(line) as FabricaEvent;
  } catch {
    return null;
  }
}

const DEFAULT_POLL_INTERVAL_MS = 1000;

function main(): void {
  const recordHome = process.env.FABRICA_HOME?.trim() || join(homedir(), ".fabrica");
  const watcher = createHerdrWatcher({ recordHome });
  setInterval(() => watcher.pollOnce(), DEFAULT_POLL_INTERVAL_MS);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
