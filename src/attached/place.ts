// Putting a task's files where the machine can read them, and taking
// them away again.
//
// The Client's ruling on this, in his own words: "Never committed by
// Fabrica: the files sit in the fixed subfolder during the run, that
// subfolder is excluded from git for the run, and it is deleted before
// the delivery commit. If the task asks for a file to land in the
// repository, the machine copies it to that real path, and that copy is
// committed like any other change."
//
// Three decisions follow from it, all visible here:
//
//   1. **The subfolder is inside the workstation**, which is the one
//      place a machine can read: its container is bind-mounted to that
//      folder and nowhere else (src/containment/). A copy anywhere else
//      on the host would be invisible to it.
//   2. **Excluded by a `.gitignore` inside the subfolder itself**,
//      holding `*` - which matches that file too, so the whole folder is
//      invisible to `git status`, `git add -A` and `git ls-files`
//      (measured, not assumed - see place.test.ts). The obvious
//      alternative, `.git/info/exclude`, was rejected: for a linked
//      worktree that file lives in the project's SHARED git directory,
//      so writing it would edit the Client's own repository - and that
//      directory is bind-mounted into the worker's box read-only anyway
//      (src/line/worktree-git.ts).
//   3. **Removed before the delivery commit**, in one place for every
//      round and every delivery shape (src/foreman/round.ts). Belt and
//      braces with the exclusion above rather than instead of it: if
//      either one alone fails, the files still never reach a commit.
//
// Nothing here ever deletes a folder it did not write. A worktree
// already carrying a `.fabrica-files/` of the project's own refuses the
// round loudly instead of being overwritten and then deleted - see
// `placeAttachedFiles`.

import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AttachedError } from "./errors.ts";
import type { AttachedFile } from "./types.ts";

/** The fixed subfolder of the workstation a task's files are copied
 * into, named once here. Dot-prefixed so it reads as machinery rather
 * than as part of the project, and one path segment so it can never
 * reach outside the workstation. */
export const ATTACHED_FOLDER = ".fabrica-files";

/** The one file inside that subfolder which is not a task's: what keeps
 * the folder out of git for the run, and the marker that proves the
 * folder is Fabrica's own before anything deletes it. */
export const IGNORE_FILE = ".gitignore";

/** Its whole contents. `*` matches every name in the folder, its own
 * included, so git sees nothing here at all. */
export const IGNORE_CONTENTS = "*\n";

/** Where a given workstation's attached files live. The one place that
 * path is spelled out: every half below joins it rather than trusting a
 * path it was handed. */
export function attachedFolderPath(workdir: string): string {
  return join(workdir, ATTACHED_FOLDER);
}

/**
 * Copies each file into `workdir`'s fixed subfolder, excluded from git
 * before any of them lands there.
 *
 * A no-op for a task with no files - it does not even create the folder,
 * so an ordinary task's branch looks exactly as it always did.
 *
 * Throws `AttachedError("copy-failed")` when the folder cannot be
 * prepared or a file cannot be copied, naming it, and the same code when
 * the workstation already carries a `.fabrica-files/` that is not
 * Fabrica's own - overwriting a folder of the project's and then
 * deleting it before the commit would delete the project's files.
 */
export function placeAttachedFiles(workdir: string, files: AttachedFile[]): void {
  if (files.length === 0) return;

  const folder = attachedFolderPath(workdir);
  if (existsNotOurs(folder)) {
    throw new AttachedError(
      "copy-failed",
      `${folder} already exists in this project and is not Fabrica's own, so a task's files cannot be ` +
        `copied there - they would overwrite it, and it is removed before this round's commit. Rename that ` +
        `folder in the project.`
    );
  }

  try {
    mkdirSync(folder, { recursive: true });
    // Written first, so there is no moment at which a file sits in a
    // folder git can still see.
    writeFileSync(join(folder, IGNORE_FILE), IGNORE_CONTENTS);
  } catch (err) {
    throw new AttachedError(
      "copy-failed",
      `could not prepare ${folder} for this task's files: ${(err as NodeJS.ErrnoException).code ?? String(err)}.`
    );
  }

  for (const file of files) {
    try {
      copyFileSync(file.path, join(folder, file.name));
    } catch (err) {
      throw new AttachedError(
        "copy-failed",
        `could not copy ${file.path} into ${folder}: ${(err as NodeJS.ErrnoException).code ?? String(err)}.`
      );
    }
  }
}

/**
 * Removes that subfolder, leaving the rest of the workstation untouched.
 * Idempotent, and a no-op when there is no such folder - every ordinary
 * task's round calls this.
 *
 * Only ever removes a folder Fabrica itself wrote: one without the
 * `.gitignore` marker `placeAttachedFiles` puts there is left exactly as
 * it is, since it is the project's own.
 */
export function removeAttachedFiles(workdir: string): void {
  const folder = attachedFolderPath(workdir);
  if (!isOurs(folder)) return;
  rmSync(folder, { recursive: true, force: true });
}

/** Whether this folder is one `placeAttachedFiles` wrote: it is there,
 * and it holds the exact `.gitignore` that function writes. */
function isOurs(folder: string): boolean {
  try {
    if (!statSync(folder).isDirectory()) return false;
    return readFileSync(join(folder, IGNORE_FILE), "utf8") === IGNORE_CONTENTS;
  } catch {
    return false;
  }
}

/** Whether something is already at this path that Fabrica did not put
 * there - the one state `placeAttachedFiles` refuses on. */
function existsNotOurs(folder: string): boolean {
  try {
    statSync(folder);
  } catch {
    return false;
  }
  return !isOurs(folder);
}
