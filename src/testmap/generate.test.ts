// Generating a first map from the colocated convention: the two lines
// each test file produces, and the two things deliberately left out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generatedHeader, generateTestMap } from "./generate.ts";
import { parseTestMap, renderTestMap } from "./parse.ts";

function makeProject(files: string[]): string {
  const project = mkdtempSync(join(tmpdir(), "fabrica-testmap-gen-"));
  for (const file of files) {
    mkdirSync(join(project, dirname(file)), { recursive: true });
    writeFileSync(join(project, file), "");
  }
  return project;
}

test("a colocated pair becomes two entries: the source, and the test file itself", () => {
  const project = makeProject(["src/cli/main.ts", "src/cli/main.test.ts"]);

  assert.deepEqual(generateTestMap(project), [
    { pattern: "src/cli/main.test.ts", tests: ["src/cli/main.test.ts"], line: 1 },
    { pattern: "src/cli/main.ts", tests: ["src/cli/main.test.ts"], line: 2 },
  ]);
});

test("a test file with no colocated source still covers itself", () => {
  // Under this convention nearly every task edits a test file as well as
  // its source. Without this line those edits would be reported as
  // unmapped on almost every delivery, which would make the unmapped
  // report noise instead of a signal.
  const project = makeProject(["contract/rule1.isolation.test.ts"]);
  assert.deepEqual(generateTestMap(project), [
    { pattern: "contract/rule1.isolation.test.ts", tests: ["contract/rule1.isolation.test.ts"], line: 1 },
  ]);
});

test("a source file with no colocated test of its own is left unmapped on purpose", () => {
  const project = makeProject(["src/foreman/judge.ts", "src/foreman/round.ts", "src/foreman/round.test.ts"]);

  const patterns = generateTestMap(project).map((entry) => entry.pattern);

  assert.ok(!patterns.includes("src/foreman/judge.ts"));
  assert.deepEqual(patterns, ["src/foreman/round.test.ts", "src/foreman/round.ts"]);
});

test("both colocated spellings are read, and the extension has to match", () => {
  const project = makeProject([
    "src/a.ts",
    "src/a.spec.ts",
    "src/b.mjs",
    "src/b.test.mjs",
    // A test whose stem matches a source of a DIFFERENT extension is
    // not that source's colocated test.
    "src/c.ts",
    "src/c.test.mjs",
  ]);

  const byPattern = new Map(generateTestMap(project).map((entry) => [entry.pattern, entry.tests]));

  assert.deepEqual(byPattern.get("src/a.ts"), ["src/a.spec.ts"]);
  assert.deepEqual(byPattern.get("src/b.mjs"), ["src/b.test.mjs"]);
  assert.ok(!byPattern.has("src/c.ts"));
  assert.ok(byPattern.has("src/c.test.mjs"));
});

test("dependency trees, build output and dotted folders are never walked", () => {
  const project = makeProject([
    "src/a.ts",
    "src/a.test.ts",
    "node_modules/pkg/x.test.ts",
    "dist/x.test.ts",
    ".github/x.test.ts",
  ]);

  const patterns = generateTestMap(project).map((entry) => entry.pattern);
  assert.deepEqual(patterns, ["src/a.test.ts", "src/a.ts"]);
});

test("entries come out sorted by pattern, so a regeneration diffs rather than reshuffles", () => {
  const project = makeProject(["src/z.ts", "src/z.test.ts", "src/a.ts", "src/a.test.ts"]);
  const patterns = generateTestMap(project).map((entry) => entry.pattern);
  assert.deepEqual(patterns, [...patterns].sort());
});

test("a generated file is readable by the parser, header and all", () => {
  const project = makeProject(["src/a.ts", "src/a.test.ts"]);
  const entries = generateTestMap(project);
  const text = `${generatedHeader()}\n\n${renderTestMap(entries)}`;

  assert.deepEqual(
    parseTestMap(text).map((entry) => ({ pattern: entry.pattern, tests: entry.tests })),
    entries.map((entry) => ({ pattern: entry.pattern, tests: entry.tests }))
  );
});
