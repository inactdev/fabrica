// Reading a project's committed `tests.map`, and the one check this
// repository's own file gets.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readTestMap, testMapPath, writeTestMap } from "./load.ts";
import { parseTestMap, TEST_MAP_FILENAME } from "./parse.ts";
import { TestMapError } from "./errors.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function makeProject(map?: string): string {
  const project = mkdtempSync(join(tmpdir(), "fabrica-testmap-load-"));
  if (map !== undefined) writeFileSync(join(project, TEST_MAP_FILENAME), map);
  return project;
}

test("a project with no tests.map reads as null, not as an empty map", () => {
  // The difference matters downstream: null means "this project maps
  // nothing", and a delivery then carries no test-map report at all
  // rather than one claiming every touched file is unmapped.
  assert.equal(readTestMap(makeProject()), null);
});

test("readTestMap reads the committed file from the project root", () => {
  const project = makeProject("src/cli/main.ts: src/cli/main.test.ts\n");
  assert.equal(testMapPath(project), join(project, TEST_MAP_FILENAME));
  assert.deepEqual(readTestMap(project), [
    { pattern: "src/cli/main.ts", tests: ["src/cli/main.test.ts"], line: 1 },
  ]);
});

test("a tests.map with an unreadable line is refused, not half-read", () => {
  const project = makeProject("src/cli/main.ts: src/cli/main.test.ts\nnonsense\n");
  assert.throws(
    () => readTestMap(project),
    (err: unknown) => err instanceof TestMapError && err.code === "malformed-test-map"
  );
});

test("writeTestMap writes a file readTestMap reads back, under its header", () => {
  const project = makeProject();
  writeTestMap(project, [{ pattern: "src/cli/*.ts", tests: ["a.test.ts", "b.test.ts"], line: 1 }], "# a header");

  const text = readFileSync(testMapPath(project), "utf8");
  assert.ok(text.startsWith("# a header\n"));
  // `line` is the line in the written file, header included - a
  // broken-mapping report names the line the Client has to open and
  // edit, so it has to count the header rather than the entries.
  assert.deepEqual(readTestMap(project), [
    { pattern: "src/cli/*.ts", tests: ["a.test.ts", "b.test.ts"], line: 3 },
  ]);
});

// This repository's own committed map, which every task against it now
// reads. Deliberately NOT a staleness check: the Client's ruling is that
// a source file with no mapping, and a mapping whose test file has gone,
// are surfaced on every delivery's own report rather than by a check
// here. What this asserts is only that the file is readable at all - a
// hand edit that breaks the format would otherwise fail every task on
// this project, one task at a time, instead of failing here once.
test("this repository's committed tests.map parses", () => {
  const entries = parseTestMap(readFileSync(join(repoRoot, TEST_MAP_FILENAME), "utf8"), TEST_MAP_FILENAME);
  assert.ok(entries.length > 0, `${TEST_MAP_FILENAME} has no entries`);
});
