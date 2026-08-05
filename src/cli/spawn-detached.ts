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

export interface SpawnDetachedTaskOptions {
  recordHome: string;
  projectPath: string;
  taskText: string;
  /** Overridden in tests to point at a fixture entry script that uses a
   * fake brain, so exercising the real spawn-and-discover mechanism
   * never has to invoke the real adapter's coding agent. */
  entryScript?: string;
  timeoutMs?: number;
}

/** Spawns the task's loop in a separate, detached process and resolves
 * with its id as soon as that process registers the task - it does
 * NOT wait for the task to finish. */
export async function spawnDetachedTask(opts: SpawnDetachedTaskOptions): Promise<{ taskId: string }> {
  const { recordHome, projectPath, taskText, entryScript = DEFAULT_ENTRY_SCRIPT, timeoutMs } = opts;

  // A first-ever `fabrica do` on a fresh machine has no recordHome yet -
  // registerTask would create it in time, but that happens inside the
  // detached child, after this file already needs it to exist.
  mkdirSync(recordHome, { recursive: true });
  const logFd = openSync(join(recordHome, "cli.log"), "a");
  const child = spawn(
    process.execPath,
    [BOOTSTRAP, entryScript, recordHome, projectPath, taskText],
    { detached: true, stdio: ["ignore", logFd, logFd] }
  );
  closeSync(logFd); // the child holds its own duplicated copy from here on

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
    return { taskId };
  } finally {
    watchCancel.abort();
    child.removeAllListeners("error");
    child.unref();
  }
}
