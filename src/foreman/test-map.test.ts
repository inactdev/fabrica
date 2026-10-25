// The round-level half of src/testmap/: that a project's committed map
// is read off the disk fresh, that an unreadable one refuses the round
// by name (and before any ProductionLine exists - see the brief tests in
// touched-tests.test.ts for that half), and that a project committing no
// map produces no report rather than an empty one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportForRound, testMapFor } from "./test-map.ts";
import { ForemanError } from "./errors.ts";
import { TEST_MAP_FILENAME } from "../testmap/index.ts";

function makeProject(map?: string): string {
  const project = mkdtempSync(join(tmpdir(), "fabrica-foreman-testmap-"));
  if (map !== undefined) writeFileSync(join(project, TEST_MAP_FILENAME), map);
  return project;
}

test("testMapFor reads the project's committed map, and null for a project with none", () => {
  assert.equal(testMapFor(makeProject()), null);
  assert.deepEqual(testMapFor(makeProject("src/a.ts: src/a.test.ts\n")), [
    { pattern: "src/a.ts", tests: ["src/a.test.ts"], line: 1 },
  ]);
});

test("an unreadable tests.map refuses the round as test-map-unreadable, carrying the message verbatim", () => {
  const project = makeProject("src/a.ts: src/a.test.ts\nnonsense\n");

  assert.throws(
    () => testMapFor(project),
    (err: unknown) => {
      assert.ok(err instanceof ForemanError, `not a ForemanError: ${err}`);
      assert.equal(err.code, "test-map-unreadable");
      // src/testmap's own message already names the file, the line and
      // the fix; it is carried through, never restated or softened -
      // the same contract task-knowledge.ts keeps with src/knowledge.
      assert.match(err.message, /^tests\.map line 2 is not a mapping/);
      return true;
    }
  );
});

test("reportForRound gives no report at all for a project with no map", () => {
  // Not an empty report: that would read as "nothing about this round
  // was mapped" when the truth is "nothing here maps anything", and
  // every delivery would then carry an unmapped list of its whole diff.
  assert.equal(reportForRound(null, makeProject(), ["src/a.ts"]), undefined);
  assert.equal(reportForRound(undefined, makeProject(), ["src/a.ts"]), undefined);
});

test("reportForRound resolves the round's files and carries the worker's own list", () => {
  const project = makeProject("src/a.ts: src/a.test.ts\n");
  const entries = testMapFor(project)!;

  const report = reportForRound(entries, project, ["src/a.ts", "src/b.ts"], "src/a.test.ts");

  assert.deepEqual(report?.tests, ["src/a.test.ts"]);
  assert.deepEqual(report?.unmapped, ["src/b.ts"]);
  assert.equal(report?.reportedByWorker, "src/a.test.ts");
  // The mapping names a test file this throwaway project does not have,
  // so it is reported broken - continued past, never thrown on.
  assert.deepEqual(report?.broken, [{ pattern: "src/a.ts", test: "src/a.test.ts", line: 1 }]);
});
