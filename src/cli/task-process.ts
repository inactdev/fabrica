// Finding and signaling the detached process running one task's round
// (issue #203's `stop`). This is `live-view-process.ts`'s discipline
// applied to a task instead of the live view, for the same reason and
// with the same two safeguards: a pid file the process writes about
// itself, plus a real command-line check before anything is ever
// signaled, because a stale pid file's number can be reused by an
// unrelated process. Nothing here ever signals a pid it has not
// re-verified, and nothing here ever searches for "the process that
// looks like it might be this task."
//
// Why the pid file rather than a `ps` search alone: `fabrica answer`'s
// and `fabrica verdict fix`'s detached runners both carry the task id in
// their own argv, but `fabrica do`'s does not - its argv is
// `<recordHome> <projectPath> <taskText>`, and the task id is minted
// inside the child, after the spawn (spawn-detached.ts watches the
// record from the outside to learn it). The child writing its own pid
// into its own task folder is the one place that fact is known for
// certain.

import { readTaskFile, writeTaskFile } from "../record/index.ts";
import { listProcesses } from "./live-view-process.ts";

/** How long a signaled task's process gets to shut down on its own
 * before it is killed outright (Client ruling, issue #203's
 * clarification: "SIGTERM, then SIGKILL after a 10-second grace"). */
export const STOP_GRACE_MS = 10_000;

/** The three detached runners a task's round can be running under
 * (spawn-detached.ts's own entry scripts). Matched as substrings of
 * `ps`'s `args` column rather than absolute paths, so this works for a
 * dev checkout and a globally installed copy alike - the same approach
 * `LIVE_VIEW_COMMAND_MARKER` already takes. */
const DO_MARKER = "src/cli/run-task-entry.ts";
const ANSWER_MARKER = "src/cli/answer-entry.ts";
const FIX_MARKER = "src/cli/verdict-fix-entry.ts";

/** Called by each detached task runner once it knows which task it is
 * running - `run-task-entry.ts` from `onTaskRegistered` (the task id
 * does not exist before that), `answer-entry.ts`/`verdict-fix-entry.ts`
 * straight away, since theirs arrives in argv. Overwritten each round,
 * so the file always names the process running the CURRENT round rather
 * than accumulating history: the record's own events are where history
 * belongs. */
export function writeTaskPidFile(recordHome: string, taskId: string): void {
  writeTaskFile(recordHome, taskId, "worker.pid", String(process.pid));
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

/** Whether this command line is one of Fabrica's own task runners, and -
 * for the two whose argv carries the task id - this task's. `fabrica
 * do`'s runner has no task id to check (see this file's header), so for
 * that one the marker plus the per-task pid file is the whole of the
 * attribution; that is a deliberately named limit, not an oversight. */
export function commandLineMatchesTask(args: string, taskId: string): boolean {
  if (args.includes(ANSWER_MARKER) || args.includes(FIX_MARKER)) return args.includes(taskId);
  return args.includes(DO_MARKER);
}

export interface FindTaskProcessOptions {
  /** Replaces the real process table - tests use it rather than
   * spawning something that has to look like a Fabrica task runner. */
  listProcesses?: () => { pid: number; args: string }[];
}

/**
 * The real, currently-running process for this task's round, or null
 * when none can be identified. Deliberately only ever one source: the
 * task's own `worker.pid`, which must be both alive and still running a
 * command line that matches (`commandLineMatchesTask`). There is no
 * fallback scan of the process table the way `findLiveViewProcess` has
 * one - the live view is a single shared process on a single known
 * port, whereas several tasks run at once and a scan could only guess
 * which of them it had found.
 */
export function findTaskProcess(
  recordHome: string,
  taskId: string,
  opts: FindTaskProcessOptions = {}
): { pid: number } | null {
  const raw = readTaskFile(recordHome, taskId, "worker.pid");
  if (raw === null) return null;
  const pid = Number(raw.trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!isProcessAlive(pid)) return null;

  const list = opts.listProcesses ?? listProcesses;
  const match = list().find((p) => p.pid === pid);
  return match && commandLineMatchesTask(match.args, taskId) ? { pid } : null;
}

/** Sends one signal to the process group a verified task runner leads,
 * falling back to the bare pid. The group, not just the pid, because
 * every one of these runners is spawned `detached: true` - which on
 * POSIX makes it a session (and so process group) leader, the very
 * thing that keeps a closed terminal from killing it - and its real
 * work happens in children it spawned (the worker's container, and the
 * `caffeinate` wrapper around it on macOS). Signaling the leader alone
 * would stop the bookkeeping and leave the spending running. A group
 * whose leader has already exited answers ESRCH, which is the fallback's
 * only reason to exist. */
function signalTaskProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") return false;
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

export interface StopTaskProcessOptions {
  graceMs?: number;
  /** Test seam: replaces the real `setTimeout` for the grace period, so
   * a test can run the SIGKILL step immediately instead of waiting ten
   * real seconds. */
  schedule?: (fn: () => void, ms: number) => void;
}

/**
 * SIGTERM now, SIGKILL after the grace period if it is still alive
 * (Client ruling, issue #203's clarification). Returns as soon as the
 * SIGTERM is away - the caller is answering an HTTP request and must
 * not hold the connection open for ten seconds, and the record already
 * says the task is stopped either way. The grace timer is `unref`'d so
 * it can never hold a process open on its own account.
 *
 * `pid` must be one `findTaskProcess` returned. Nothing else in this
 * module or anywhere else may call this with a pid from another source.
 */
export function stopTaskProcess(pid: number, opts: StopTaskProcessOptions = {}): boolean {
  const sentTerm = signalTaskProcess(pid, "SIGTERM");

  const schedule =
    opts.schedule ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
    });

  schedule(() => {
    if (isProcessAlive(pid)) signalTaskProcess(pid, "SIGKILL");
  }, opts.graceMs ?? STOP_GRACE_MS);

  return sentTerm;
}
