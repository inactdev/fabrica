// The worker's box, used to self-test a project that has no Inspector
// (issue #64, mode b): the project's check runs inside the same kind of
// container the worker ran in, never on the host. Which box that is
// belongs to the adapter (CONTRACT rule 8), so the Foreman only ever sees
// this shape.

export type BoxCheckResult =
  /** The box ran the command; `output` is stdout and stderr together. */
  | { ran: true; exitCode: number; output: string }
  /** The box itself could not be started (no Docker, missing image...). */
  | { ran: false; reason: string };

export type CheckBox = (workdir: string, command: string) => Promise<BoxCheckResult>;
