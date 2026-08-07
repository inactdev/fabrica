import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBaseline, writeBaseline } from "./baseline.ts";
import type { ProjectGitState } from "./types.ts";

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-offbooks-baseline-"));
}

test("readBaseline: a project never seen before reads as null", () => {
  const recordHome = tempRecordHome();
  assert.equal(readBaseline(recordHome, "spending-app"), null);
});

test("writeBaseline then readBaseline: round-trips exactly", () => {
  const recordHome = tempRecordHome();
  const state: ProjectGitState = { branch: "main", headCommit: "a".repeat(40), dirty: [" M app.txt"] };
  writeBaseline(recordHome, "spending-app", state);
  assert.deepEqual(readBaseline(recordHome, "spending-app"), state);
});

test("writeBaseline: is human-readable JSON, one file per project (SPEC.md's 'read with bare hands')", () => {
  const recordHome = tempRecordHome();
  writeBaseline(recordHome, "spending-app", { branch: "main", headCommit: "a".repeat(40), dirty: [] });
  const path = join(recordHome, "offbooks", "spending-app.json");
  const text = readFileSync(path, "utf8");
  assert.doesNotThrow(() => JSON.parse(text));
});

test("readBaseline: a corrupted baseline file reads as null rather than throwing", () => {
  const recordHome = tempRecordHome();
  mkdirSync(join(recordHome, "offbooks"), { recursive: true });
  writeFileSync(join(recordHome, "offbooks", "spending-app.json"), "{ not valid json");
  assert.equal(readBaseline(recordHome, "spending-app"), null);
});

test("writeBaseline: a project name with unsafe path characters never escapes the offbooks directory", () => {
  const recordHome = tempRecordHome();
  const state: ProjectGitState = { branch: "main", headCommit: "b".repeat(40), dirty: [] };
  writeBaseline(recordHome, "../../escape", state);
  assert.deepEqual(readBaseline(recordHome, "../../escape"), state);
  // Nothing was written outside recordHome/offbooks/ itself.
  const outside = join(recordHome, "..", "escape.json");
  assert.equal(existsSync(outside), false);
});
