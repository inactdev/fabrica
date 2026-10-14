// A Herdr integration that lives outside Fabrica's core (issue #125):
// for every task Fabrica receives, open a pane that runs `fabrica watch
// <id>` for it, and keep that pane's reported agent state in step with
// the task's own record. This file only ever reads the record
// (events.jsonl, request.md) through the same tail reader and task-file
// reader `fabrica watch` itself reads through (src/index.ts's
// createLineTail/recordPath/readTaskFile) - it never touches a running
// task's process, the same way `fabrica watch` never does.
//
// The five wrappers below are Herdr's own documented CLI
// (https://herdr.dev/docs/socket-api, /docs/agents) - not a guessed
// shape. Pane ids look like "w1:p1" (workspace:pane); `pane split`
// splits an EXISTING pane and hands back the new one, so this watcher
// needs a pane to split FROM - the pane it itself is running in, which
// Herdr injects into every process it starts as $HERDR_PANE_ID (see
// README.md's "Starting it"). Only these five one-line functions would
// need to change if Herdr's CLI shape changes; everything else here
// only depends on them.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLineTail, readTaskFile, recordPath } from "../../src/index.ts";
import type { FabricaEvent } from "../../src/index.ts";

type AgentState = "working" | "blocked" | "done";

const TITLE_MAX_LENGTH = 60;

/** The `--source` every call below reports under, and the `--agent`
 * every report-agent call reports as, scoped per task so two tasks'
 * rows never collide in Herdr's own agent registry. */
const REPORT_SOURCE = "custom:fabrica";
const SUMMARY_SOURCE = "custom:fabrica-display";
const agentIdFor = (taskId: string) => `fabrica-${taskId}`;

function resolveHerdrBin(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env.HERDR_BIN;
  if (override !== undefined && override.trim().length > 0) return override.trim().split(/\s+/);
  return ["herdr"];
}

function callHerdr(bin: string[], args: string[]): string {
  return execFileSync(bin[0], [...bin.slice(1), ...args], { encoding: "utf8" });
}

/** `herdr pane split <pane-id> --direction right` - splits `fromPaneId`
 * and returns the id of the new pane it creates alongside it. */
function splitPane(bin: string[], fromPaneId: string): string {
  return callHerdr(bin, ["pane", "split", fromPaneId, "--direction", "right"]).trim();
}

/** `herdr pane run <pane-id> "<command>"` - one argv element, not a
 * shell string: execFileSync never invokes a shell, so `command` reaches
 * Herdr exactly as given with no quoting to get right or wrong. */
function runInPane(bin: string[], paneId: string, command: string): void {
  callHerdr(bin, ["pane", "run", paneId, command]);
}

/** `herdr agent rename <pane-id> <name>` - names the pane's row. */
function renameAgent(bin: string[], paneId: string, name: string): void {
  callHerdr(bin, ["agent", "rename", paneId, name]);
}

/** `herdr pane report-agent <pane-id> --source custom:fabrica --agent
 * fabrica-<task-id> --state working|blocked|done`. */
function reportAgent(bin: string[], paneId: string, taskId: string, state: AgentState): void {
  callHerdr(bin, [
    "pane",
    "report-agent",
    paneId,
    "--source",
    REPORT_SOURCE,
    "--agent",
    agentIdFor(taskId),
    "--state",
    state,
  ]);
}

/** `herdr pane report-metadata <pane-id> --source
 * custom:fabrica-display --token summary=<title>` - the row's one-line
 * summary, shown via the Agent sidebar's `$summary` token. */
function reportSummary(bin: string[], paneId: string, title: string): void {
  callHerdr(bin, ["pane", "report-metadata", paneId, "--source", SUMMARY_SOURCE, "--token", `summary=${title}`]);
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
  /** The pane every task's pane is split from - defaults to
   * $HERDR_PANE_ID, the id Herdr injects into this watcher's own
   * environment when it's started inside a pane (see README.md).
   * Overridable for tests, which run with no real Herdr pane around
   * them at all. */
  basePaneId?: string;
  /** The command run in each newly opened pane. Defaults to `fabrica
   * watch <id>`, carrying this watcher's own FABRICA_HOME along so the
   * pane watches the same record regardless of Herdr's own environment. */
  watchCommandFor?: (taskId: string) => string;
}

export function createHerdrWatcher(opts: CreateHerdrWatcherOptions): HerdrWatcher {
  const { recordHome } = opts;
  const bin = opts.herdrBin ?? resolveHerdrBin();
  const basePaneId = opts.basePaneId ?? process.env.HERDR_PANE_ID;
  if (basePaneId === undefined || basePaneId.trim().length === 0) {
    throw new Error(
      "herdr-watcher: no pane to split from. Run this inside a Herdr pane (it sets $HERDR_PANE_ID " +
        "for every process it starts), or pass basePaneId explicitly."
    );
  }
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
          const title = titleFor(recordHome, event.taskId);
          const paneId = splitPane(bin, basePaneId);
          runInPane(bin, paneId, watchCommandFor(event.taskId));
          renameAgent(bin, paneId, title);
          reportSummary(bin, paneId, title);
          panes.set(event.taskId, paneId);
          continue;
        }

        const state = stateForEvent(event);
        if (state === null) continue;
        const paneId = panes.get(event.taskId);
        if (paneId === undefined) continue; // not a task this watcher opened a pane for
        reportAgent(bin, paneId, event.taskId, state);
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

const PID_FILE_NAME = "herdr-watcher.pid";

function pidFilePath(recordHome: string): string {
  return join(recordHome, PID_FILE_NAME);
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 sends nothing - it only reports whether a process with
    // this pid exists (ESRCH if not), the standard liveness check this
    // has no safer alternative to (see up-hook.ts's own reasoning).
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means a process with this pid exists but isn't ours to
    // signal - still alive, just not killable by us.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether a herdr watcher is already running for this record home,
 * read from the pid file `main()` writes on startup and checked for
 * real liveness rather than trusted at face value - a watcher that was
 * killed outright (not through its own exit) would otherwise leave a
 * stale file claiming forever that one is already running. A stale
 * file is removed so the next start writes a fresh one. */
export function isHerdrWatcherRunning(recordHome: string): boolean {
  const path = pidFilePath(recordHome);
  if (!existsSync(path)) return false;
  const pid = Number(readFileSync(path, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (isProcessAlive(pid)) return true;
  try {
    unlinkSync(path);
  } catch {
    // Best-effort cleanup only - a failed unlink just means the next
    // check re-does this same work, not a problem.
  }
  return false;
}

function writePidFile(recordHome: string): void {
  writeFileSync(pidFilePath(recordHome), String(process.pid), "utf8");
}

function main(): void {
  const recordHome = process.env.FABRICA_HOME?.trim() || join(homedir(), ".fabrica");
  const watcher = createHerdrWatcher({ recordHome });
  writePidFile(recordHome);
  setInterval(() => watcher.pollOnce(), DEFAULT_POLL_INTERVAL_MS);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
