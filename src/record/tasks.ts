// Per-task folders: tasks/<id>/ holding task.md, plan.md, delivery.md,
// verdict, transcript.log (SPEC.md "The record"). These are a convenience
// view of events.jsonl, not a second source of truth — registerTask logs
// the "task-received" event itself so the two never drift apart.
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

export function taskDir(home: string, id: string): string {
  return join(home, "tasks", id);
}

export function taskFilePath(home: string, id: string, file: TaskFile): string {
  return join(taskDir(home, id), file);
}

/** Overwrites a task file (used once each for plan.md, delivery.md, verdict). */
export function writeTaskFile(home: string, id: string, file: TaskFile, content: string): void {
  mkdirSync(taskDir(home, id), { recursive: true });
  writeFileSync(taskFilePath(home, id, file), content);
}

/** Appends to a task file (task.md's Q&A rounds, transcript.log streaming). */
export function appendTaskFile(home: string, id: string, file: TaskFile, content: string): void {
  mkdirSync(taskDir(home, id), { recursive: true });
  appendFileSync(taskFilePath(home, id, file), content);
}

/** Reads a task file, or null if it hasn't been written yet. */
export function readTaskFile(home: string, id: string, file: TaskFile): string | null {
  try {
    return readFileSync(taskFilePath(home, id, file), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Registers a new task (SPEC.md `fabrica do` step 1): claims a collision-free
 * id, creates its folder, saves the task text verbatim to task.md, and logs
 * "task-received" on the record.
 */
export function registerTask(
  home: string,
  taskText: string,
  opts: { now?: Date } = {}
): { id: string; dir: string } {
  const now = opts.now ?? new Date();
  mkdirSync(join(home, "tasks"), { recursive: true });

  const id = claimTaskId(taskText, now, (candidate) => claimDir(home, candidate));
  writeTaskFile(home, id, "task.md", taskText);
  appendEvent(home, { task: id, event: "task-received" });

  return { id, dir: taskDir(home, id) };
}

/** Exclusively claims tasks/<id>/ as this task's folder. False if taken. */
function claimDir(home: string, id: string): boolean {
  try {
    mkdirSync(taskDir(home, id));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}
