// Resolving touched files against a map: the union rule, the unmapped
// report, and the broken-mapping report - the three the Client ruled on
// directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { brokenMappings, looksLikePath, testMapReport } from "./match.ts";
import { parseTestMap } from "./parse.ts";

/** A throwaway project holding the given files, by project-relative path. */
function makeProject(files: string[]): string {
  const project = mkdtempSync(join(tmpdir(), "fabrica-testmap-"));
  for (const file of files) {
    mkdirSync(join(project, dirname(file)), { recursive: true });
    writeFileSync(join(project, file), "");
  }
  return project;
}

test("a touched file takes the union of every entry it matches, not the most specific one", () => {
  const entries = parseTestMap(
    ["src/cli/*.ts: src/cli/suite.test.ts", "src/cli/main.ts: src/cli/main.test.ts"].join("\n")
  );

  const report = testMapReport(entries, ["src/cli/main.ts"]);

  assert.deepEqual(report.mapped, [
    { file: "src/cli/main.ts", tests: ["src/cli/suite.test.ts", "src/cli/main.test.ts"] },
  ]);
  assert.deepEqual(report.tests, ["src/cli/suite.test.ts", "src/cli/main.test.ts"]);
  assert.deepEqual(report.unmapped, []);
});

test("the round's test list is deduped across files, in first-seen order", () => {
  const entries = parseTestMap(["src/cli/*.ts: suite.test.ts, a.test.ts", "src/line/*.ts: suite.test.ts"].join("\n"));

  const report = testMapReport(entries, ["src/cli/main.ts", "src/cli/help.ts", "src/line/cut.ts"]);

  assert.deepEqual(report.tests, ["suite.test.ts", "a.test.ts"]);
  assert.equal(report.mapped.length, 3);
});

test("a touched code file no entry matches is reported as unmapped, never dropped", () => {
  const entries = parseTestMap("src/cli/*.ts: src/cli/suite.test.ts");

  const report = testMapReport(entries, ["src/cli/main.ts", "stray.txt", "src/cli/helpers/fake.ts"]);

  // "src/cli/*.ts" does not cross a separator, so the nested file is
  // genuinely uncovered and has to say so.
  assert.deepEqual(report.unmapped, ["stray.txt", "src/cli/helpers/fake.ts"]);
  assert.deepEqual(
    report.mapped.map((entry) => entry.file),
    ["src/cli/main.ts"]
  );
});

test("documentation no entry matches is counted as nothing at all - not unmapped, not mapped", () => {
  const entries = parseTestMap("src/cli/*.ts: src/cli/suite.test.ts");

  // Issue #305: the delivery's list is the files that genuinely lack a
  // test, and prose never lacked one. Silence there means nothing is
  // missing.
  const report = testMapReport(entries, [
    "README.md",
    "notes/20261028-a-note.md",
    "integrations/live-view/docs/shape.txt",
    ".gitignore",
    "LICENSE",
    "src/cli/main.ts",
  ]);

  assert.deepEqual(report.unmapped, []);
  assert.deepEqual(
    report.mapped.map((entry) => entry.file),
    ["src/cli/main.ts"]
  );
});

test("a mapping that does cover documentation is still honoured", () => {
  // The exemption is only about what counts as *missing* a test. A
  // project pointing its docs at a link checker gets that checker named.
  const entries = parseTestMap("docs/**: npm run docs-lint");

  const report = testMapReport(entries, ["docs/architecture.md"]);

  assert.deepEqual(report.tests, ["npm run docs-lint"]);
  assert.deepEqual(report.mapped, [{ file: "docs/architecture.md", tests: ["npm run docs-lint"] }]);
  assert.deepEqual(report.unmapped, []);
});

test("a touched test file no entry matches is mapped to itself, and named as a test to run", () => {
  const entries = parseTestMap("src/cli/main.ts: src/cli/main.test.ts");

  const report = testMapReport(entries, ["src/cli/main.ts", "./src/cli/brand-new.test.ts"]);

  assert.deepEqual(report.unmapped, []);
  assert.deepEqual(report.mapped, [
    { file: "src/cli/main.ts", tests: ["src/cli/main.test.ts"] },
    // The map's own path shape, whatever shape the caller passed it in.
    { file: "./src/cli/brand-new.test.ts", tests: ["src/cli/brand-new.test.ts"] },
  ]);
  assert.deepEqual(report.tests, ["src/cli/main.test.ts", "src/cli/brand-new.test.ts"]);
});

test("a touched file is matched by its project-relative, forward-slashed form", () => {
  const entries = parseTestMap("src/cli/main.ts: src/cli/main.test.ts");
  assert.deepEqual(testMapReport(entries, ["./src/cli/main.ts"]).unmapped, []);
  assert.deepEqual(testMapReport(entries, ["src\\cli\\main.ts"]).unmapped, []);
});

test("a mapping naming a test file the project does not have is reported broken, with its line", () => {
  const project = makeProject(["src/cli/main.ts", "src/cli/main.test.ts"]);
  const entries = parseTestMap(
    ["src/cli/main.ts: src/cli/main.test.ts", "src/cli/help.ts: src/cli/help.test.ts"].join("\n")
  );

  assert.deepEqual(brokenMappings(entries, project), [
    { pattern: "src/cli/help.ts", test: "src/cli/help.test.ts", line: 2 },
  ]);

  // And it reaches the report, independently of which files this round
  // happened to touch - a stale mapping is stale either way.
  const report = testMapReport(entries, ["src/cli/stray.ts"], { projectPath: project });
  assert.equal(report.broken.length, 1);
  assert.deepEqual(report.unmapped, ["src/cli/stray.ts"]);
});

test("a mapping naming a command is never reported broken", () => {
  const project = makeProject(["package.json"]);
  const entries = parseTestMap("src/cli/*.ts: npm test -- src/cli");

  // There is no honest way to tell whether a command is stale without
  // running it, and this side never runs one - so it is left alone
  // rather than reported as missing on every delivery.
  assert.deepEqual(brokenMappings(entries, project), []);

  assert.ok(looksLikePath("src/cli/main.test.ts"));
  assert.ok(!looksLikePath("npm test -- src/cli"));
  assert.ok(!looksLikePath("npx vitest run src/cli/*.test.ts"));
});

test("broken mappings are only reported when there is a checkout to look at", () => {
  const entries = parseTestMap("src/cli/help.ts: src/cli/help.test.ts");
  // No projectPath: nothing is known about what exists, so nothing is
  // claimed - never "every mapping is broken".
  assert.deepEqual(testMapReport(entries, ["src/cli/help.ts"]).broken, []);
});

test("the worker's own report rides along verbatim, and an empty one is left out", () => {
  const entries = parseTestMap("src/cli/main.ts: src/cli/main.test.ts");

  assert.equal(
    testMapReport(entries, ["src/cli/main.ts"], { reportedByWorker: "  src/cli/main.test.ts  " }).reportedByWorker,
    "src/cli/main.test.ts"
  );
  assert.equal(testMapReport(entries, ["src/cli/main.ts"], { reportedByWorker: "   " }).reportedByWorker, undefined);
  assert.equal(testMapReport(entries, ["src/cli/main.ts"]).reportedByWorker, undefined);
});
