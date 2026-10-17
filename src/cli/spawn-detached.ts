// The backgrounding mechanism itself (verified against the real Node
// runtime on this project's target OS, not assumed - see the module
// README for what was actually tried). `detached: true` + `stdio:
// 'ignore'` + `unref()` is Node's own documented shape for a child that
// must keep running after its parent exits: on POSIX, `detached: true`
// makes the child a session leader (setsid), which is what stops a
// closed terminal's SIGHUP from ever reaching it - the exact
// requirement issue #47's comment states plainly ("closing the terminal
// must not kill a running task").
//
// The child's own stdout/stderr are redirected to <recordHome>/cli.log
// rather than truly ignored: doTask() and the written Brain adapter
// never write to their own process's stdio (a CLI-family adapter
// captures its own subprocess's output into the transcript itself -
// see src/brain/adapters/README.md), so nothing should land here in
// the ordinary case, but an unexpected crash in this process (as
// opposed to a normal task failure, which is do()'s own concern) would
// otherwise vanish into a process nobody is watching.

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { CliError } from "./errors.ts";
import { watchForTaskId } from "./watch-for-task-id.ts";

const BOOTSTRAP = fileURLToPath(new URL("./tsx-bootstrap.mjs", import.meta.url));
const DEFAULT_ENTRY_SCRIPT = fileURLToPath(new URL("./run-task-entry.ts", import.meta.url));
const DEFAULT_ANSWER_ENTRY_SCRIPT = fileURLToPath(new URL("./answer-entry.ts", import.meta.url));
const DEFAULT_VERDICT_FIX_ENTRY_SCRIPT = fileURLToPath(new URL("./verdict-fix-entry.ts", import.meta.url));
const DEFAULT_LIVE_VIEW_ENTRY_SCRIPT = fileURLToPath(new URL("../../integrations/live-view/start.ts", import.meta.url));

export interface SpawnDetachedTaskOptions {
  recordHome: string;
  projectPath: string;
  taskText: string;
  /** The issue number the chat agent names explicitly (do-args.ts's
   * `--issue`) - forwarded as a trailing positional so run-task-entry.ts
   * can pass it on to doTask. Omitted, nothing is appended. */
  issue?: number;
  /** Overridden in tests to point at a fixture entry script that uses a
   * fake brain, so exercising the real spawn-and-discover mechanism
   * never has to invoke the real adapter's coding agent. */
  entryScript?: string;
  timeoutMs?: number;
}

/** Spawns the task's loop in a separate, detached process and resolves
 * with its id as soon as that process registers the task - it does
 * NOT wait for the task to finish. */
export async function spawnDetachedTask(
  opts: SpawnDetachedTaskOptions
): Promise<{ taskId: string; isRunning: () => boolean }> {
  const { recordHome, projectPath, taskText, issue, entryScript = DEFAULT_ENTRY_SCRIPT, timeoutMs } = opts;

  // A first-ever `fabrica do` on a fresh machine has no recordHome yet -
  // registerTask would create it in time, but that happens inside the
  // detached child, after this file already needs it to exist.
  mkdirSync(recordHome, { recursive: true });
  const logFd = openSync(join(recordHome, "cli.log"), "a");
  const child = spawn(
    process.execPath,
    [BOOTSTRAP, entryScript, recordHome, projectPath, taskText, ...(issue !== undefined ? [String(issue)] : [])],
    { detached: true, stdio: ["ignore", logFd, logFd] }
  );
  closeSync(logFd); // the child holds its own duplicated copy from here on

  // Whether the task's process is still running, for a caller waiting on
  // its record: once it has exited, what it recorded is all there is.
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  const spawnFailure = new Promise<never>((_, reject) => {
    child.once("error", (err: NodeJS.ErrnoException) => {
      reject(
        new CliError(
          "spawn-failed",
          `fabrica do: could not start the background process (${err.code ?? err.message}).`
        )
      );
    });
  });

  const watchCancel = new AbortController();
  try {
    const taskId = await Promise.race([
      watchForTaskId({ recordHome, taskText, timeoutMs, signal: watchCancel.signal }),
      spawnFailure,
    ]);
    return { taskId, isRunning: () => !exited };
  } finally {
    watchCancel.abort();
    child.removeAllListeners("error");
    child.unref();
  }
}

export interface SpawnDetachedResumeOptions {
  recordHome: string;
  taskId: string;
  /** "answer" resumes a clarified task; "fix" re-enters a delivered
   * task's warm worker with the Client's note (verdict.ts's
   * runRecordedFix). Picks the real default entry script; tests
   * override with `entryScript` the same way spawnDetachedTask's
   * callers do. */
  kind: "answer" | "fix";
  entryScript?: string;
}

/**
 * Hands an already-validated-and-recorded round (issue #123:
 * `recordAnswerDecision`/`recordVerdictDecision` already ran in the
 * foreground, synchronously, before this is called) to a detached
 * process and returns without waiting for it - unlike
 * `spawnDetachedTask`, there is nothing to watch for: the taskId is
 * already known (the Client passed it in), and there is no ask-first
 * decision point that needs to reach this terminal before it can print
 * anything meaningful. Progress from here on is followed through the
 * record (`fabrica log`/`status`/`watch`), the same as any task
 * `fabrica do` already backgrounds past `"work-started"`.
 */
export function spawnDetachedResume(opts: SpawnDetachedResumeOptions): void {
  const { recordHome, taskId, kind } = opts;
  const entryScript = opts.entryScript ?? (kind === "answer" ? DEFAULT_ANSWER_ENTRY_SCRIPT : DEFAULT_VERDICT_FIX_ENTRY_SCRIPT);

  mkdirSync(recordHome, { recursive: true });
  const logFd = openSync(join(recordHome, "cli.log"), "a");
  const child = spawn(process.execPath, [BOOTSTRAP, entryScript, recordHome, taskId], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);

  // A spawn failure here is as rare as `spawnDetachedTask`'s own (the
  // same `process.execPath` that is already running this command) - this
  // is purely to stop Node from treating an unlistened "error" event on
  // the child as an uncaught exception in this process; there is no
  // promise left to reject into once this function has already returned.
  child.on("error", (err: NodeJS.ErrnoException) => {
    console.error(`fabrica: could not start the background process for "${taskId}" (${err.code ?? err.message}).`);
  });
  child.unref();
}

export interface SpawnDetachedLiveViewOptions {
  recordHome: string;
  /** Test-only: points at a fixture entry script instead of the real
   * live view server, the same way spawnDetachedTask's callers override
   * entryScript. */
  entryScript?: string;
}

/**
 * Starts the live view (`integrations/live-view`) the same detached way
 * `spawnDetachedTask` backgrounds a task - `detached: true`, stdio
 * redirected to the same `cli.log`, unref'd - so closing the terminal
 * `fabrica up` ran in can't take it down either. Unlike a task, there is
 * nothing on the record to watch for afterward: the live view's own
 * server is the only signal that it's up, so the caller (`fabrica up`)
 * polls the port itself rather than this function returning a promise
 * that waits for anything.
 */
export function spawnDetachedLiveView(opts: SpawnDetachedLiveViewOptions): void {
  const { recordHome, entryScript = DEFAULT_LIVE_VIEW_ENTRY_SCRIPT } = opts;

  mkdirSync(recordHome, { recursive: true });
  const logFd = openSync(join(recordHome, "cli.log"), "a");
  const child = spawn(process.execPath, [BOOTSTRAP, entryScript], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, FABRICA_HOME: recordHome },
  });
  closeSync(logFd);

  // As rare as spawnDetachedTask's own spawn failure (same
  // process.execPath already running this command) - just stops Node
  // from treating an unlistened "error" event as an uncaught exception.
  child.on("error", (err: NodeJS.ErrnoException) => {
    console.error(`fabrica: could not start the live view (${err.code ?? err.message}).`);
  });
  child.unref();
}

export interface SpawnDetachedScriptOptions {
  recordHome: string;
  entryScript: string;
  /** Extra environment for the detached child, merged over this
   * process's own env - the same inheritance spawnDetachedLiveView
   * already relies on to carry FABRICA_HOME through to its own child
   * (and, for a caller spawned from inside some other environment,
   * whatever that environment already set on this process). */
  env?: NodeJS.ProcessEnv;
}

/**
 * The same detached-and-forgotten mechanism as spawnDetachedLiveView
 * (`detached: true` + stdio redirected to <recordHome>/cli.log +
 * unref'd, so closing the terminal that started it can't take it down
 * either), generalized to any entry script. This is the seam an
 * integrations/ module reaches for when it needs to background its own
 * long-running process the same way `fabrica up` backgrounds the live
 * view - kept as its own function, rather than folding
 * spawnDetachedLiveView's existing body into it, so that function's own
 * already-tested behavior and error wording are untouched by this.
 */
export function spawnDetachedScript(opts: SpawnDetachedScriptOptions): void {
  const { recordHome, entryScript, env } = opts;

  mkdirSync(recordHome, { recursive: true });
  const logFd = openSync(join(recordHome, "cli.log"), "a");
  const child = spawn(process.execPath, [BOOTSTRAP, entryScript], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, ...env },
  });
  closeSync(logFd);

  child.on("error", (err: NodeJS.ErrnoException) => {
    console.error(`fabrica: could not start the background process for "${entryScript}" (${err.code ?? err.message}).`);
  });
  child.unref();
}
