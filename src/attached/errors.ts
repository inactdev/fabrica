// AttachedError: every refusal this module produces carries a `code` for
// callers that need to branch on it, and a `message` written to be shown
// to the Client verbatim. src/foreman/task-files.ts carries these
// messages on unchanged, the same way task-issue.ts carries src/github's
// and task-knowledge.ts carries src/knowledge's.

export type AttachedErrorCode =
  /** A named path has nothing at it, or nothing this machine may read. */
  | "no-such-file"
  /** A named path is there but is not a regular file - a folder, a
   * socket, a device. A folder is the likely slip, and copying one
   * silently would put an unbounded tree in the workstation. */
  | "not-a-file"
  /** Two named paths end in the same file name, so one copy would
   * overwrite the other inside the fixed subfolder. Refused rather than
   * renamed: a brief naming `spec.md` when the task meant the other
   * `spec.md` is worse than being told to rename one. */
  | "duplicate-name"
  /** A named path's own file name is one the fixed subfolder already
   * uses for its own purposes (`.gitignore`, which is what keeps the
   * subfolder out of git for the run). */
  | "reserved-name"
  /** The copy into the workstation itself failed - a full disk, a
   * permission change between the task being registered and the round
   * starting, a file that has gone since. */
  | "copy-failed";

export class AttachedError extends Error {
  constructor(
    readonly code: AttachedErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AttachedError";
  }
}
