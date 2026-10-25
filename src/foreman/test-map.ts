// The committed test map a project carries into every brief and every
// delivery - the Foreman's half of src/testmap/.
//
// Shaped after src/foreman/task-knowledge.ts, deliberately, because the
// two have the same job and the same sharp edge: read the project's own
// file BEFORE the ProductionLine is cut, so a file nobody can read fails
// the task while there is still nothing to tear down and nothing spent,
// and name the line to fix in the message rather than carrying on with
// half of it.
//
// Read fresh every round, never written to the record. A map corrected
// between rounds is a map the next round should read corrected - the same
// reasoning task-knowledge.ts spells out for a knowledge note, and the
// opposite of the issue a task names, which is the request itself and is
// frozen.
//
// Fabrica never runs any of these tests. It names them to the worker,
// which runs them in its own box, and records what the worker says it
// ran. Running a project's tests on the host is exactly what issue #64
// settled against, and `src/foreman/no-host-check.test.ts` fails if
// anything under this folder spawns anything but `git`.

import { readTestMap, TestMapError, testMapReport } from "../testmap/index.ts";
import type { TestMapEntry, TestMapReport } from "../testmap/index.ts";
import { ForemanError } from "./errors.ts";

/**
 * The project's test map as it is on disk now, or `null` when it commits
 * none - which is the ordinary case and leaves every brief and delivery
 * exactly as they were before test maps existed.
 *
 * Throws `ForemanError("test-map-unreadable")` when the file is there
 * and malformed. The message is src/testmap's own, which already names
 * the file, the line and the fix; callers run inside `recordingFailure`,
 * so it lands on the task's record as `task-failed` with that cause.
 */
export function testMapFor(projectPath: string): TestMapEntry[] | null {
  try {
    return readTestMap(projectPath);
  } catch (err) {
    if (!(err instanceof TestMapError)) throw err;
    throw new ForemanError("test-map-unreadable", err.message);
  }
}

/**
 * This round's report: `files` resolved against `entries`, with the
 * worker's own account of which mapped tests it ran attached as-is.
 *
 * Undefined when the project commits no map - a delivery then carries no
 * `tests` field at all, rather than an empty report that would read as
 * "nothing was mapped" when the truth is "nothing maps anything here".
 */
export function reportForRound(
  entries: TestMapEntry[] | null | undefined,
  projectPath: string,
  files: string[],
  reportedByWorker?: string
): TestMapReport | undefined {
  if (entries === null || entries === undefined) return undefined;
  return testMapReport(entries, files, {
    projectPath,
    ...(reportedByWorker === undefined ? {} : { reportedByWorker }),
  });
}
