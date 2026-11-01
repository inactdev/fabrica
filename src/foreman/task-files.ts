// The files a task was handed (`fabrica do --file <path>`, issue #325),
// carried into every round of it - the Foreman's half of src/attached/.
//
// Three jobs, deliberately apart, each run at the point that makes its
// own refusal cheap:
//
//   - `freezeAttachedFiles` resolves the paths once, at registration
//     (ask.ts), and writes them to the task's own `files.json`. A typo
//     is refused there, before anything spends, and every later round -
//     an answered one, a fix round in another process - reads the list
//     back rather than being handed it again. This is the same
//     persist-once-at-registration shape `--issue` and `--model` already
//     use (task-issue.ts, model.ts), and for the same reason: nothing
//     about a file lives in the task's text for a round to re-derive.
//   - `attachedFilesFor` reads that list back and proves each file is
//     still there to copy. Every caller runs it BEFORE its
//     ProductionLine is cut or reopened, so a file that has gone missing
//     since fails the round with no line behind it, naming which - the
//     same timing task-knowledge.ts's notes get.
//   - `placeAttachedFiles`/`removeAttachedFiles` put the copies in the
//     workstation and take them away again (src/attached/place.ts owns
//     the exclusion-from-git half and the Client's ruling behind it).
//
// What is deliberately NOT frozen is the files' contents. The record
// keeps each file's path, name and size; the bytes are read off the disk
// at each round, like a knowledge note and unlike an issue's words. A
// document the Client corrects between rounds is one the next round
// should read corrected, and copying every handed-over file into the
// record home would duplicate possibly large data for every task that
// ever used one.

import { readTaskFile, writeTaskFile } from "../record/index.ts";
import {
  AttachedError,
  placeAttachedFiles as placeFiles,
  removeAttachedFiles as removeFiles,
  resolveAttachedFiles,
  withAttachedFiles as withFiles,
} from "../attached/index.ts";
import type { AttachedFile } from "../attached/index.ts";
import { ForemanError } from "./errors.ts";

export type { AttachedFile };

/**
 * Resolves the paths `fabrica do --file <path>` named and writes them to
 * this task's record, once, at registration. Returns them in the order
 * they were named - the same order every later round reads them in.
 *
 * Always writes the file, an empty list included, so "this task was
 * handed nothing" is recorded as a fact rather than as a missing file
 * that could equally mean "a task from before this existed".
 *
 * Throws `ForemanError("attached-unavailable")` when a named path has
 * nothing readable at it, is not a regular file, collides with another's
 * file name, or is named `.gitignore`.
 */
export function freezeAttachedFiles(recordHome: string, taskId: string, paths: string[]): AttachedFile[] {
  let files: AttachedFile[];
  try {
    files = resolveAttachedFiles(paths);
  } catch (err) {
    throw asForemanError(err);
  }
  writeTaskFile(recordHome, taskId, "files.json", JSON.stringify(files));
  return files;
}

/**
 * The files this task was handed, read back off its record and proved
 * still readable. Empty for a task that was handed none, and for every
 * task registered before this existed.
 *
 * Throws `ForemanError("attached-unavailable")` when a file is no longer
 * there - the Client moved or deleted it between rounds - naming it.
 * Callers run this before any ProductionLine is cut, so that refusal
 * costs nothing but the reading.
 */
export function attachedFilesFor(recordHome: string, taskId: string): AttachedFile[] {
  const stored = storedAttachedFiles(recordHome, taskId);
  if (stored.length === 0) return [];
  try {
    // Re-resolved from the paths the record holds rather than returned
    // as stored: that is what re-reads the disk, and what makes a file
    // that has gone missing fail here instead of halfway through the
    // round. The sizes therefore come back as they are today - the
    // recorded ones are what was handed over at registration, and
    // nothing compares the two (see this file's header).
    return resolveAttachedFiles(stored.map((file) => file.path));
  } catch (err) {
    throw asForemanError(err);
  }
}

/**
 * What the record itself says this task was handed, with nothing
 * re-read: the names and sizes as of registration. For a reader of the
 * record rather than for a round, which wants `attachedFilesFor` above.
 *
 * Throws `ForemanError("attached-unavailable")` for a `files.json`
 * nothing can parse - a record that cannot be read is never quietly
 * treated as an empty one.
 */
export function storedAttachedFiles(recordHome: string, taskId: string): AttachedFile[] {
  const text = readTaskFile(recordHome, taskId, "files.json");
  if (text === null || text.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ForemanError(
      "attached-unavailable",
      `task "${taskId}"'s record of the files it was handed (files.json) is not readable JSON, so there is ` +
        `no telling what this task was given. Fix or remove that file.`
    );
  }
  if (!Array.isArray(parsed) || !parsed.every(isAttachedFile)) {
    throw new ForemanError(
      "attached-unavailable",
      `task "${taskId}"'s record of the files it was handed (files.json) is not a list of files, so there ` +
        `is no telling what this task was given. Fix or remove that file.`
    );
  }
  return parsed;
}

/** Copies this round's files into the workstation's fixed subfolder,
 * excluded from git before any of them lands there (src/attached). A
 * no-op for a task that was handed none. */
export function placeAttachedFiles(workdir: string, files: AttachedFile[]): void {
  try {
    placeFiles(workdir, files);
  } catch (err) {
    throw asForemanError(err);
  }
}

/** Takes that subfolder away again, before this round's work is
 * committed (round.ts). Idempotent, and a no-op for a workstation that
 * never had one. */
export function removeAttachedFiles(workdir: string): void {
  removeFiles(workdir);
}

/** `briefText` with these files named as their own section - after the
 * task's own words, and inside the standing prefix every brief is handed
 * to a Worker behind. `placed` is false only for the clarifying step,
 * which runs before any workstation exists. */
export function withAttachedFiles(briefText: string, files: AttachedFile[], opts: { placed: boolean }): string {
  return withFiles(briefText, files, opts);
}

function isAttachedFile(value: unknown): value is AttachedFile {
  if (typeof value !== "object" || value === null) return false;
  const file = value as Partial<AttachedFile>;
  return typeof file.path === "string" && typeof file.name === "string" && typeof file.bytes === "number";
}

/** src/attached's messages are already complete, actionable sentences
 * naming the path - carried verbatim, never restated or softened,
 * exactly as task-knowledge.ts carries src/knowledge's. */
function asForemanError(err: unknown): unknown {
  if (!(err instanceof AttachedError)) return err;
  return new ForemanError("attached-unavailable", err.message);
}
