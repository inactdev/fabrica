// The shapes `tests.map` is read into, and the report a delivery carries
// about it. Internal to this module and its two consumers
// (src/foreman/touched-tests.ts for the brief, src/foreman/round.ts for
// the delivery) - nothing here appears in contract/surface.ts, since a
// test map is a project's own bookkeeping about its own suite, not a seam
// Fabrica promises the Client.

/** One line of `tests.map`. */
export interface TestMapEntry {
  /** The glob this entry covers, exactly as written. */
  pattern: string;
  /** The test files or commands that cover it, in the order written. */
  tests: string[];
  /** Which line of the file this was read from, 1-based - so a malformed
   * or broken entry can be named by the line the Client has to edit. */
  line: number;
}

/** One touched file and every test that covers it: the union of every
 * matching entry's tests, in first-match order. */
export interface MappedFile {
  file: string;
  tests: string[];
}

/** A mapping that names a test file the project does not have (issue:
 * per-project test map, Client ruling: "record it as a broken mapping in
 * the delivery and continue"). Only path-shaped targets are ever checked
 * - see `match.ts`'s `looksLikePath`. */
export interface BrokenMapping {
  pattern: string;
  /** The test path that is not in the project. */
  test: string;
  line: number;
}

/**
 * What a round reports about the test map: which tests the touched files
 * mapped to, which touched files mapped to nothing, which mappings point
 * at a test file that is gone, and - separately, and marked as the
 * worker's own words - which of those mapped tests the worker says it
 * actually ran.
 *
 * `reportedByWorker` is deliberately never cross-checked against `tests`
 * (Client ruling: "The record is the worker's own report and is marked as
 * such; Inspector's full-suite run is the independent check and is not
 * asked to verify the list"). Comparing them would invent a verdict
 * Fabrica has no evidence for - the worker's box is where the tests ran,
 * and the whole suite runs afterwards either way.
 */
export interface TestMapReport {
  /** Every touched file that matched at least one entry, with its tests. */
  mapped: MappedFile[];
  /** Every test named by `mapped`, deduped, in first-seen order - what
   * the brief told the worker to run. */
  tests: string[];
  /** Touched files no entry matched. Named in the delivery and on the
   * status row, never silently skipped - the whole suite still runs, so
   * nothing is actually unchecked; what is missing is the fast, targeted
   * run, and that is what this says. */
  unmapped: string[];
  /** Mappings naming a test file that is not in the project. */
  broken: BrokenMapping[];
  /** The worker's own report of which mapped tests it ran, verbatim.
   * Absent when the worker reported none. */
  reportedByWorker?: string;
}
