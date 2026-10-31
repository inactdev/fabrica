// The internal shapes of an attached file. Nothing here appears in
// contract/surface.ts: a file handed to a task is Fabrica's own
// plumbing, not part of what Fabrica promises the Client about a
// Delivery or a Receipt.

/**
 * One file `fabrica do --file <path>` was given, as the record carries
 * it (src/foreman/task-files.ts writes these to the task's own
 * `files.json`, once, at registration).
 *
 * `path` is the host path, absolute: a later round runs in its own
 * process, with its own working directory, so a relative path would mean
 * something different each time. `name`/`bytes` are what the issue asks
 * be recorded on the task - the name the workstation copy carries, and
 * the size the file had when the task was registered.
 */
export interface AttachedFile {
  /** Absolute host path the Client named the file by. */
  path: string;
  /** Its bare file name, which is also the name of the copy placed in
   * the workstation's fixed subfolder. Unique across one task's files. */
  name: string;
  /** Its size in bytes at registration. Recorded, never enforced: it is
   * there so a reader of the record knows what was handed over. */
  bytes: number;
}
