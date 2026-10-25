// `fabrica tests-map` - what it writes, and the two things it refuses
// to do rather than write something that reads as more complete than it
// is.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runTestsMapCommand } from "./tests-map-command.ts";
import { readTestMap, TEST_MAP_FILENAME } from "../index.ts";

function makeProject(files: string[]): string {
  const project = mkdtempSync(join(tmpdir(), "fabrica-tests-map-cli-"));
  for (const file of files) {
    mkdirSync(join(project, dirname(file)), { recursive: true });
    writeFileSync(join(project, file), "");
  }
  return project;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) }, out, err };
}

test("it writes a readable map from the colocated convention and says what it wrote", () => {
  const project = makeProject(["src/cli/main.ts", "src/cli/main.test.ts", "src/cli/help.ts"]);
  const { io, out, err } = capture();

  assert.equal(runTestsMapCommand([project], io, "/"), 0);

  assert.deepEqual(err, []);
  assert.match(out[0], /^wrote .*tests\.map: 2 entries naming 1 test\.$/);
  // The honest half: the convention leaves gaps, and the Client is told
  // to close them by hand rather than left to discover it per delivery.
  assert.match(out[1], /edit it by hand/);
  assert.match(out[1], /reported as unmapped/);

  const entries = readTestMap(project)!;
  assert.deepEqual(
    entries.map(({ pattern, tests }) => ({ pattern, tests })),
    [
      { pattern: "src/cli/main.test.ts", tests: ["src/cli/main.test.ts"] },
      { pattern: "src/cli/main.ts", tests: ["src/cli/main.test.ts"] },
    ]
  );

  const text = readFileSync(join(project, TEST_MAP_FILENAME), "utf8");
  assert.match(text, /^# tests\.map - which tests cover/);
  // Line numbers are the written file's own lines, header included - a
  // broken-mapping report names the line the Client has to open.
  const firstEntryLine = text.split("\n").findIndex((line) => line.startsWith("src/")) + 1;
  assert.equal(entries[0].line, firstEntryLine);
});

test("an existing map is never replaced without --force", () => {
  const project = makeProject(["src/a.ts", "src/a.test.ts"]);
  const byHand = "# mine\nsrc/**: npm test\n";
  writeFileSync(join(project, TEST_MAP_FILENAME), byHand);

  const refused = capture();
  assert.equal(runTestsMapCommand([project], refused.io, "/"), 1);
  assert.deepEqual(refused.out, []);
  assert.match(refused.err[0], /already exists/);
  assert.match(refused.err[0], /--force/);
  assert.equal(readFileSync(join(project, TEST_MAP_FILENAME), "utf8"), byHand, "a hand-edited map was overwritten");

  const forced = capture();
  assert.equal(runTestsMapCommand([project, "--force"], forced.io, "/"), 0);
  assert.notEqual(readFileSync(join(project, TEST_MAP_FILENAME), "utf8"), byHand);
});

test("a project where the convention finds nothing gets no file at all, and is told why", () => {
  // An empty map would report every touched file as unmapped forever
  // while looking deliberate, which is worse than having none.
  const project = makeProject(["src/a.ts", "README.md"]);
  const { io, out, err } = capture();

  assert.equal(runTestsMapCommand([project], io, "/"), 1);
  assert.deepEqual(out, []);
  assert.match(err[0], /found no test files/);
  assert.match(err[0], /foo\.test\.ts/);
  assert.equal(readTestMap(project), null, "a file was written anyway");
});

test("a path that is not a directory refuses, naming where it looked", () => {
  const { io, err } = capture();
  assert.equal(runTestsMapCommand(["no-such-project"], io, tmpdir()), 1);
  assert.match(err[0], /is not a directory \(looked for /);
});

test("a bad invocation refuses with the usage line and writes nothing", () => {
  const { io, err } = capture();
  assert.equal(runTestsMapCommand(["--nope"], io, "/"), 1);
  assert.match(err[0], /unknown flag "--nope"/);
});
