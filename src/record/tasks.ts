// Per-task folders: tasks/<id>/ holding request.md, answers.md, brief.md,
// plan.md, delivery.md, verdict, transcript.log, and - only on a
// discarded-protected-path outcome - discarded.patch (SPEC.md "The
// record"). All but discarded.patch are a convenience view of
// events.jsonl, not a second source of truth — registerTask logs the
// "task-received" event itself so the two never drift apart.
// discarded.patch is the one exception: its content exists only here,
// never in the event log (only the delivery's gaps text points at it).
//
// Id collisions: claimTaskId (ids.ts) hands out candidates; claiming a
// directory with mkdir (no `recursive`) is what actually decides
// uniqueness, atomically at the OS level. Two callers racing for the same
// candidate — even from different processes, even in the same second —
// can never both win, so registerTask retries instead of colliding.

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { appendEvent } from "./append.ts";
import { claimTaskId } from "./ids.ts";
import type { TaskFile } from "./types.ts";

export function taskDir(recordHome: string, id: string): string {
  return join(recordHome, "tasks", id);
}

export function taskFilePath(recordHome: string, id: string, file: TaskFile): string {
  return join(taskDir(recordHome, id), file);
}

/** Overwrites a task file (used once each for request.md, plan.md, delivery.md, verdict). */
export function writeTaskFile(recordHome: string, id: string, file: TaskFile, content: string): void {
  mkdirSync(taskDir(recordHome, id), { recursive: true });
  writeFileSync(taskFilePath(recordHome, id, file), content);
}

/** Appends to a task file (answers.md's Q&A rounds, transcript.log streaming). */
export function appendTaskFile(recordHome: string, id: string, file: TaskFile, content: string): void {
  mkdirSync(taskDir(recordHome, id), { recursive: true });
  appendFileSync(taskFilePath(recordHome, id, file), content);
}

/** Reads a task file, or null if it hasn't been written yet. */
export function readTaskFile(recordHome: string, id: string, file: TaskFile): string | null {
  try {
    return readFileSync(taskFilePath(recordHome, id, file), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Registers a new task (SPEC.md `fabrica do` step 1): claims a collision-free
 * id, creates its folder, saves the task text verbatim to request.md — once,
 * never appended to — and logs "task-received" on the record.
 */
export function registerTask(
  recordHome: string,
  taskText: string,
  opts: { now?: Date } = {}
): { id: string; dir: string } {
  const now = opts.now ?? new Date();
  mkdirSync(join(recordHome, "tasks"), { recursive: true });

  const id = claimTaskId(taskText, now, (candidate) => claimDir(recordHome, candidate));
  writeTaskFile(recordHome, id, "request.md", taskText);
  appendEvent(recordHome, { taskId: id, name: "task-received" });

  return { id, dir: taskDir(recordHome, id) };
}

/** Exclusively claims tasks/<id>/ as this task's folder. False if taken. */
function claimDir(recordHome: string, id: string): boolean {
  try {
    mkdirSync(taskDir(recordHome, id));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}
