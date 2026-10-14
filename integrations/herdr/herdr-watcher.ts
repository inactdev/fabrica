// A Herdr integration that lives outside Fabrica's core (rebuilt around
// the four Herdr commands the Client has verified by hand on his real
// Herdr - see README.md): for every task Fabrica receives, open a tab
// whose pane runs `fabrica watch <id>`, and keep that pane's reported
// agent state in step with the task's own record. This file only ever
// reads the record (events.jsonl, request.md) through the same tail
// reader and task-file reader `fabrica watch` itself reads through
// (src/index.ts's createLineTail/recordPath/readTaskFile) - it never
// touches a running task's process, the same way `fabrica watch` itself
// never does.
//
// Six Herdr commands are ever called - no `pane split`, no `agent
// rename`, no `pane report-metadata`:
//   1. `herdr tab create --no-focus --label "<title>"` - opens the tab,
//      pane id and tab id taken from the JSON response's
//      `result.root_pane.pane_id` and `result.tab.tab_id` (never from
//      raw stdout otherwise).
//   2. `herdr pane run <pane_id> "<command>"` - one argv element, not a
//      shell string: execFileSync never invokes a shell, so `command`
//      reaches Herdr exactly as given with no quoting to get right or
//      wrong.
//   3. `herdr pane report-agent <pane_id> --source custom:fabrica
//      --agent "<title>" --state working|idle|blocked --seq N
//      [--message "..."]`.
//   4. `herdr pane release-agent <pane_id> --source custom:fabrica
//      --agent "<title>" --seq N`.
//   5. `herdr pane send-keys <pane_id> ctrl+c` - sent right after
//      release, on a closing verdict only, so the `fabrica watch`
//      running in that pane stops cleanly before the tab goes away.
//   6. `herdr tab close <tab_id>` - closes the tab itself, last of all.
// Only these six wrapper functions (callHerdr's six callers below)
// should need to change if Herdr's CLI shape ever changes.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLineTail, readTaskFile, recordPath } from "../../src/index.ts";
import type { FabricaEvent } from "../../src/index.ts";

/** The only three states this integration ever reports - Herdr's own
 * CLI also accepts "unknown", but nothing here ever sends it. */
type AgentState = "working" | "idle" | "blocked";

const TITLE_MAX_LENGTH = 60;

/** The `--source` every report-agent/release-agent call reports under,
 * and the `--agent` every one of them reports as (the task's own title,
 * not a synthetic id - there is no `agent rename` call to give it a
 * name separately). */
const REPORT_SOURCE = "custom:fabrica";

function resolveHerdrBin(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env.HERDR_BIN;
  if (override !== undefined && override.trim().length > 0) return override.trim().split(/\s+/);
  return ["herdr"];
}

function callHerdr(bin: string[], args: string[]): string {
  return execFileSync(bin[0], [...bin.slice(1), ...args], { encoding: "utf8" });
}

const LOG_FILE_NAME = "herdr-watcher.log";

export function herdrWatcherLogPath(recordHome: string): string {
  return join(recordHome, LOG_FILE_NAME);
}

/** Herdr's own documented error shape (https://herdr.dev/llms-full.txt):
 * on timeout or another server error, a CLI command prints a JSON error
 * to stderr and exits 1; invalid syntax exits 2 with no such promise. Not
 * parsed further here - the raw text is exactly what gets logged. */
function describeHerdrFailure(err: unknown): string {
  if (err !== null && typeof err === "object") {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const stderr = e.stderr?.toString().trim();
    const stdout = e.stdout?.toString().trim();
    const parts = [stderr, stdout].filter((part): part is string => !!part && part.length > 0);
    if (parts.length > 0) return parts.join(" | ");
    if (e.message) return e.message;
  }
  return String(err);
}

/** A failing Herdr call is logged with its exact arguments and Herdr's
 * own output, to this record home's own `herdr-watcher.log` - and the
 * watcher keeps running. It must never exit because one command failed,
 * so every call site below goes through this instead of letting
 * execFileSync's throw propagate. A failure to write the log itself is
 * swallowed for the same reason: logging a problem must never become a
 * second one. */
function logHerdrFailure(recordHome: string, args: string[], err: unknown): void {
  const line = `${new Date().toISOString()} herdr ${args.join(" ")} failed: ${describeHerdrFailure(err)}\n`;
  try {
    appendFileSync(herdrWatcherLogPath(recordHome), line, "utf8");
  } catch {
    // best-effort only - see the comment above.
  }
}

/** Runs a Herdr call, returning its stdout on success or null (after
 * logging) on failure. Every one of the four wrapper functions below
 * goes through this - never a bare callHerdr. */
function tryHerdr(bin: string[], recordHome: string, args: string[]): string | null {
  try {
    return callHerdr(bin, args);
  } catch (err) {
    logHerdrFailure(recordHome, args, err);
    return null;
  }
}

/** `herdr tab create --no-focus --label "<title>"` - returns the new
 * tab's root pane id and tab id, taken from the JSON response's
 * `result.root_pane.pane_id` and `result.tab.tab_id` (never from raw
 * stdout), or null if the call failed or either field wasn't there. */
function createTab(bin: string[], recordHome: string, title: string): { paneId: string; tabId: string } | null {
  const args = ["tab", "create", "--no-focus", "--label", title];
  const output = tryHerdr(bin, recordHome, args);
  if (output === null) return null;
  try {
    const parsed = JSON.parse(output) as {
      result?: { root_pane?: { pane_id?: string }; tab?: { tab_id?: string } };
    };
    const paneId = parsed.result?.root_pane?.pane_id;
    const tabId = parsed.result?.tab?.tab_id;
    if (typeof paneId === "string" && paneId.length > 0 && typeof tabId === "string" && tabId.length > 0) {
      return { paneId, tabId };
    }
    logHerdrFailure(recordHome, args, `no result.root_pane.pane_id/result.tab.tab_id in output: ${output}`);
    return null;
  } catch (err) {
    logHerdrFailure(recordHome, args, err);
    return null;
  }
}

/** `herdr pane run <pane_id> "<command>"`. */
function runInPane(bin: string[], recordHome: string, paneId: string, command: string): void {
  tryHerdr(bin, recordHome, ["pane", "run", paneId, command]);
}

/** `herdr pane report-agent <pane_id> --source custom:fabrica --agent
 * "<title>" --state working|idle|blocked --seq N [--message "..."]`. */
function reportAgent(
  bin: string[],
  recordHome: string,
  paneId: string,
  title: string,
  state: AgentState,
  seq: number,
  message?: string
): void {
  const args = ["pane", "report-agent", paneId, "--source", REPORT_SOURCE, "--agent", title, "--state", state, "--seq", String(seq)];
  if (message !== undefined) args.push("--message", message);
  tryHerdr(bin, recordHome, args);
}

/** `herdr pane release-agent <pane_id> --source custom:fabrica --agent
 * "<title>" --seq N`. */
function releaseAgent(bin: string[], recordHome: string, paneId: string, title: string, seq: number): void {
  tryHerdr(bin, recordHome, ["pane", "release-agent", paneId, "--source", REPORT_SOURCE, "--agent", title, "--seq", String(seq)]);
}

/** `herdr pane send-keys <pane_id> ctrl+c` - sent to the pane running
 * `fabrica watch` right before its tab closes, so that process stops
 * cleanly instead of being torn down mid-read by the tab going away. */
function sendCtrlC(bin: string[], recordHome: string, paneId: string): void {
  tryHerdr(bin, recordHome, ["pane", "send-keys", paneId, "ctrl+c"]);
}

/** `herdr tab close <tab_id>` - closes the tab itself. CLI closes are
 * documented as immediate, no confirmation. */
function closeTab(bin: string[], recordHome: string, tabId: string): void {
  tryHerdr(bin, recordHome, ["tab", "close", tabId]);
}

/** The task's title - used both as the tab's `--label` and as every
 * report-agent/release-agent call's `--agent` value, so it must be
 * computed once and reused for the task's whole lifetime. request.md's
 * first non-blank line, trimmed and capped to 60 characters. Falls back
 * to the task id itself if request.md isn't there yet (a task this
 * watcher is somehow seeing before its own registration, or a test
 * fixture that only wrote the event). */
function titleFor(recordHome: string, taskId: string): string {
  const request = readTaskFile(recordHome, taskId, "request.md");
  const firstLine = request
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return taskId;
  return firstLine.length > TITLE_MAX_LENGTH ? `${firstLine.slice(0, TITLE_MAX_LENGTH - 3)}...` : firstLine;
}

type Reaction = { action: "report"; state: AgentState; message?: string } | { action: "release" };

/** What this event does to a task's reported row, or null if it does
 * nothing. Deliberately only the three states promised (working while
 * heartbeats arrive; idle once delivered, awaiting the Client's verdict;
 * blocked on a question or a failure) plus a release once a verdict
 * actually closes the task (rule 6: "accept"/"wrong" close it; "fix"
 * reopens the loop, which the next heartbeat already reports as
 * "working" again - no extra case needed here for that). */
function reactionForEvent(event: FabricaEvent): Reaction | null {
  switch (event.name) {
    case "heartbeat":
      return { action: "report", state: "working" };
    case "delivered":
      return { action: "report", state: "idle", message: "delivered - awaiting your verdict" };
    case "questions-asked":
      return { action: "report", state: "blocked", message: "asked a question" };
    case "task-failed":
      return { action: "report", state: "blocked", message: "failed - see fabrica log" };
    case "verdict-recorded": {
      const ruling = (event.details as { ruling?: string } | undefined)?.ruling;
      return ruling === "accept" || ruling === "wrong" ? { action: "release" } : null;
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

interface TaskRow {
  paneId: string;
  tabId: string;
  title: string;
  /** The last --seq value sent for this task - increases by one on
   * every report-agent/release-agent call for it. */
  seq: number;
}

export function createHerdrWatcher(opts: CreateHerdrWatcherOptions): HerdrWatcher {
  const { recordHome } = opts;
  const bin = opts.herdrBin ?? resolveHerdrBin();
  const watchCommandFor =
    opts.watchCommandFor ?? ((taskId: string) => `FABRICA_HOME=${recordHome} fabrica watch ${taskId}`);
  const tail = createLineTail(recordPath(recordHome));
  const tasks = new Map<string, TaskRow>();

  // Drain whatever is already on the record before this watcher ever
  // looks at it: this is a live follower, not a replay of history, so a
  // restart never reopens a tab for a task that was received, and
  // possibly long since closed, before this process started.
  tail();

  function nextSeq(task: TaskRow): number {
    task.seq += 1;
    return task.seq;
  }

  return {
    pollOnce() {
      for (const line of tail()) {
        const event = parseLine(line);
        if (!event) continue;

        if (event.name === "task-received") {
          const title = titleFor(recordHome, event.taskId);
          const created = createTab(bin, recordHome, title);
          if (created === null) continue; // logged already; nothing else to do for this task
          const task: TaskRow = { paneId: created.paneId, tabId: created.tabId, title, seq: 0 };
          tasks.set(event.taskId, task);
          runInPane(bin, recordHome, task.paneId, watchCommandFor(event.taskId));
          reportAgent(bin, recordHome, task.paneId, title, "working", nextSeq(task));
          continue;
        }

        const task = tasks.get(event.taskId);
        if (task === undefined) continue; // not a task this watcher opened a tab for

        const reaction = reactionForEvent(event);
        if (reaction === null) continue;

        if (reaction.action === "release") {
          releaseAgent(bin, recordHome, task.paneId, task.title, nextSeq(task));
          sendCtrlC(bin, recordHome, task.paneId);
          closeTab(bin, recordHome, task.tabId);
          tasks.delete(event.taskId); // closed for good - rule 6's "accept"/"wrong"
          continue;
        }

        reportAgent(bin, recordHome, task.paneId, task.title, reaction.state, nextSeq(task), reaction.message);
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

export type HerdrWatcherStatus = "running" | "exited" | "never-started";

/** Reads the pid file `main()` writes on startup and checks it for real
 * liveness rather than trusting it at face value - a watcher that was
 * killed outright (not through its own exit) would otherwise leave a
 * stale file claiming forever that one is already running. A stale file
 * is removed so the next start writes a fresh one. Distinguishes "never
 * started" from "exited" so a caller (fabrica up's hook) can say so only
 * when there really was a prior watcher that's gone, not on every first
 * start. */
export function herdrWatcherStatus(recordHome: string): HerdrWatcherStatus {
  const path = pidFilePath(recordHome);
  if (!existsSync(path)) return "never-started";
  const pid = Number(readFileSync(path, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return "never-started";
  if (isProcessAlive(pid)) return "running";
  try {
    unlinkSync(path);
  } catch {
    // Best-effort cleanup only - a failed unlink just means the next
    // check re-does this same work, not a problem.
  }
  return "exited";
}

export function isHerdrWatcherRunning(recordHome: string): boolean {
  return herdrWatcherStatus(recordHome) === "running";
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
