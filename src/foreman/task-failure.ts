// #73, Client ruling 2026-10-10: a failed start is never silent. Any error
// after "task-received" and before a delivery or refusal lands on the
// record as "task-failed", with its message, so a task that died is never
// left reading as one still working.

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { appendEvent } from "../record/index.ts";
import { ForemanError } from "./errors.ts";

// Errors whose own event is already on the record (ask-failed,
// cap-refused): recording them again as task-failed would say the same
// thing twice.
const alreadyRecorded = new WeakSet<object>();

export function markRecorded<T>(err: T): T {
  if (typeof err === "object" && err !== null) alreadyRecorded.add(err);
  return err;
}

export function recordTaskFailure(recordHome: string, taskId: string, err: unknown): void {
  if (typeof err === "object" && err !== null && alreadyRecorded.has(err)) return;
  markRecorded(err);
  const message = err instanceof Error ? err.message : String(err);
  appendEvent(recordHome, { taskId, name: "task-failed", details: { message } });
}

/** Runs `fn`, recording any error it throws as this task's failure. */
export async function recordingFailure<T>(recordHome: string, taskId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    recordTaskFailure(recordHome, taskId, err);
    throw err;
  }
}

/** A project must be an existing git repository's root before anything
 * is spent on a task for it - the clarifying step included. */
export function requireGitRoot(project: string): void {
  if (!existsSync(project)) {
    throw new ForemanError(
      "project-not-a-repo",
      `The project path ${project} does not exist. Fix its path in projects.toml (or pass an existing one), then try again.`
    );
  }
  let top: string;
  try {
    top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: project,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new ForemanError(
      "project-not-a-repo",
      `The project path ${project} is not a git repository. Run \`git init\` there (and commit), or point at the repository's root.`
    );
  }
  if (realpathSync(top) !== realpathSync(project)) {
    throw new ForemanError(
      "project-not-a-repo",
      `The project path ${project} is inside the git repository at ${top}, not its root. Point at ${top} instead.`
    );
  }
}
