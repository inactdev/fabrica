// The one place that may ever stop the live view (fabrica up: never
// reuse a live view running older code). Two things make this safe:
// a pid file the live view writes on its own startup, and - because a
// pid file can go stale and have its number reused by an unrelated
// process - a real command-line check before anything is ever
// signaled. Nothing here ever kills "whatever holds port 7777":
// killing by port alone would hit a process that just happens to be
// bound there, which is exactly the hazard this file exists to avoid.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PID_FILE_NAME = "live-view.pid";

/** The substring every real live-view process's command line contains
 * (it's always invoked as `node tsx-bootstrap.mjs <...>/integrations/live-view/start.ts`,
 * dev checkout or installed copy alike) - matched against `ps`'s own
 * `args` column rather than a hardcoded absolute path, so this finds
 * the process regardless of which checkout started it. */
export const LIVE_VIEW_COMMAND_MARKER = "integrations/live-view/start.ts";

function pidFilePath(recordHome: string): string {
  return join(recordHome, PID_FILE_NAME);
}

/** Called by integrations/live-view/start.ts once it's actually bound
 * to its port - never before, so a pid file never claims a live view
 * is running when the bind itself failed. */
export function writeLiveViewPidFile(recordHome: string): void {
  writeFileSync(pidFilePath(recordHome), String(process.pid), "utf8");
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 sends nothing - it only reports whether a process with
    // this pid exists (ESRCH if not).
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means a process with this pid exists but isn't ours to
    // signal - still alive, just not killable by us.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Every running process's pid and full command line, read through
 * `ps -A -o pid,args` (`-A`: every process, documented as the one flag
 * GNU ps and BSD/macOS ps agree on for this - unlike `-e`, which means
 * "all processes" on GNU ps but "show environment" on BSD ps). `-ww`
 * asks for unlimited column width first, since ps's own docs say the
 * width is otherwise undefined once output isn't a real terminal (as
 * it never is here) - a long checkout path could otherwise be
 * truncated out of the very substring this matches against. BusyBox's
 * `ps` (this project's own CI sandbox) doesn't know `-w` at all and
 * exits nonzero on it, so that attempt is retried once without it
 * rather than giving up on every process list. */
function listProcesses(): { pid: number; args: string }[] {
  const raw = psOutput();
  const lines = raw.split("\n").slice(1); // drop the "PID COMMAND" header
  const result: { pid: number; args: string }[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx === -1) continue;
    const pid = Number(trimmed.slice(0, spaceIdx));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    result.push({ pid, args: trimmed.slice(spaceIdx + 1).trim() });
  }
  return result;
}

function psOutput(): string {
  try {
    return execFileSync("ps", ["-A", "-ww", "-o", "pid,args"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    try {
      return execFileSync("ps", ["-A", "-o", "pid,args"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      // No usable `ps` at all - findLiveViewProcess below degrades to
      // "nothing found", the same as if the scan genuinely found no
      // match, never to "assume it's there".
      return "";
    }
  }
}

function commandLineMatches(args: string): boolean {
  return args.includes(LIVE_VIEW_COMMAND_MARKER);
}

/** Finds the real, currently-running live view process, or null if
 * none can be identified - never guessed from "something is listening
 * on the port" alone. Tries, in order:
 *
 * 1. This record home's own pid file - the common case (this exact
 *    `fabrica up`, or an earlier one against the same record home,
 *    started it) - but only trusted once its pid is both alive and its
 *    real command line still matches: a stale file's number can be
 *    reused by an unrelated process, so liveness alone is never enough
 *    to justify signaling it.
 * 2. A scan of every running process's command line, for the one
 *    instance that is the live view for ANY record home - it binds one
 *    shared port regardless of which record home started it, so a
 *    different `FABRICA_HOME`'s own live view is still found here even
 *    though its pid file lives elsewhere.
 *
 * Returns null, touching nothing else, if neither step identifies one -
 * that is the signal to report an error instead of stopping anything. */
export function findLiveViewProcess(recordHome: string): { pid: number } | null {
  const path = pidFilePath(recordHome);
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) {
      if (isProcessAlive(pid)) {
        const match = listProcesses().find((p) => p.pid === pid);
        if (match && commandLineMatches(match.args)) return { pid };
      } else {
        try {
          unlinkSync(path);
        } catch {
          // Best-effort cleanup only - a failed unlink just means the
          // next check re-does this same work, not a problem.
        }
      }
    }
  }

  const found = listProcesses().find((p) => commandLineMatches(p.args));
  return found ? { pid: found.pid } : null;
}

/** The only way this module ever stops a process - called exclusively
 * with a pid `findLiveViewProcess` already verified. */
export function stopLiveViewProcess(pid: number): void {
  process.kill(pid, "SIGTERM");
}
