// What a `--file <path>` value means, with no copying involved: an
// absolute path, the bare name its workstation copy will carry, and the
// size it has right now.
//
// Run twice on purpose, and that is not a redundancy:
//
//   - once at registration, to write the task's `files.json` and to
//     refuse a typo before anything spends (src/foreman/task-files.ts);
//   - once per round, before the ProductionLine is cut, so a file that
//     has gone missing since fails the round with no line behind it -
//     the same timing, and the same reason, as a project's knowledge
//     notes (src/foreman/task-knowledge.ts).
//
// The second run deliberately does NOT compare sizes against the
// recorded ones. The record says what was handed over at registration;
// a source document the Client has since corrected is his to correct,
// and refusing a round over a changed byte count would turn an edit into
// a dead task. What it does check is that there is still a readable
// regular file there to copy.

import { statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { AttachedError } from "./errors.ts";
import { IGNORE_FILE } from "./place.ts";
import type { AttachedFile } from "./types.ts";

/**
 * Every named path as an `AttachedFile`, in the order it was named.
 *
 * Paths are resolved against `cwd` (this process's own working
 * directory by default), so the result is always absolute. Throws
 * `AttachedError` on the first thing that is wrong, naming the path:
 * nothing there or nothing readable (`"no-such-file"`), something that
 * is not a regular file (`"not-a-file"`), two paths ending in the same
 * file name (`"duplicate-name"`), or a file name the fixed subfolder
 * already uses (`"reserved-name"`).
 */
export function resolveAttachedFiles(paths: string[], opts: { cwd?: string } = {}): AttachedFile[] {
  const cwd = opts.cwd ?? process.cwd();
  const files: AttachedFile[] = [];

  for (const named of paths) {
    const path = isAbsolute(named) ? named : resolve(cwd, named);
    const name = basename(path);

    if (name === IGNORE_FILE) {
      throw new AttachedError(
        "reserved-name",
        `${path} is named "${IGNORE_FILE}", which is the one name the folder your files are copied into ` +
          `uses for itself (it is what keeps that folder out of git). Rename the file, or copy it under ` +
          `another name and hand that over instead.`
      );
    }

    const already = files.find((file) => file.name === name);
    if (already !== undefined) {
      throw new AttachedError(
        "duplicate-name",
        `--file ${path} and --file ${already.path} are both copied in as "${name}", so one would overwrite ` +
          `the other. Rename one, or copy it under another name and hand that over instead.`
      );
    }

    files.push({ path, name, bytes: sizeOf(path) });
  }

  return files;
}

/** A path's size in bytes, or an `AttachedError` saying why it has
 * none. The one place this module reads the disk for a source file. */
function sizeOf(path: string): number {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch (err) {
    throw new AttachedError(
      "no-such-file",
      `--file ${path} cannot be read (${(err as NodeJS.ErrnoException).code ?? "unreadable"}). ` +
        `Name a file that is there, by a path this machine can read.`
    );
  }
  if (!stat.isFile()) {
    throw new AttachedError(
      "not-a-file",
      `--file ${path} is not a file${stat.isDirectory() ? " - it is a folder" : ""}. ` +
        `A task is handed files, one --file each, never a folder.`
    );
  }
  return stat.size;
}
