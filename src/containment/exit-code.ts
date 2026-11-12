// One renderer for "how did that process end", used wherever Fabrica
// reports a spawned command's exit code to the Client (issue #353).
//
// The problem it exists for: a process killed by a signal has no exit
// code at all - POSIX reports the signal instead, and Node hands that
// back as `null`. Every site that interpolated the value straight into a
// sentence therefore produced `exit code null`, which says neither what
// ended nor why, and - as issue #353 found - leaves the Client holding a
// message about an unreadable exit code that names no process. The issue
// asks for exactly one thing here: "Name the process whose exit code
// could not be read."
//
// So: the name is required, not optional, and a null code is described
// as a signal death rather than printed. Here rather than in
// `src/foreman/` because `ContainedRunResult.exitCode` is where the
// nullable value originates (./types.ts), and because the brain adapters
// that render it most often already depend on this module.

/** How `process` ended, always naming it.
 *
 * `name` is whatever the Client would recognise the process by - the
 * command, the check, the tool - never a pid on its own: a pid from a
 * run that is already over identifies nothing he can look at.
 *
 * `signal` is the second argument Node's `"close"`/`"exit"` events and
 * `spawnSync`'s result carry. Pass it where it is available; where it is
 * not, a null `exitCode` still says plainly that a signal is what
 * happened, since on POSIX that is the only way a code goes missing. */
export function describeExit(name: string, exitCode: number | null | undefined, signal?: string | null): string {
  if (typeof exitCode === "number") return `${name} exited ${exitCode}`;
  if (signal) return `${name} was killed by ${signal}, so it reported no exit code`;
  return `${name} reported no exit code, so a signal ended it (which one was never reported)`;
}
