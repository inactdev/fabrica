// The behavior CONTRACT.md's rule 1 makes true by construction ("it never
// touches your stuff") is exactly why everything this test file sees in a
// registered project's checkout came from outside Fabrica — see detect.ts's
// module comment for the full reasoning this suite is proving.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { readEvents } from "../record/index.ts";
import { detectUnattributedChange } from "./detect.ts";

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-offbooks-detect-"));
}

function commit(repo: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", message], { cwd: repo });
}

test("detect: the first look at a project establishes a baseline and never fires", () => {
  const recordHome = tempRecordHome();
  const repo = makeFixtureRepo();
  detectUnattributedChange(recordHome, "proj", repo);
  assert.deepEqual(readEvents(recordHome), []);
});

test("detect: an untouched project between two checks stays quiet", () => {
  const recordHome = tempRecordHome();
  const repo = makeFixtureRepo();
  detectUnattributedChange(recordHome, "proj", repo);
  detectUnattributedChange(recordHome, "proj", repo);
  assert.deepEqual(readEvents(recordHome), []);
});

test("detect: a hand edit to a tracked file fires unattributed-change, naming the file", () => {
  const recordHome = tempRecordHome();
  const repo = makeFixtureRepo();
  detectUnattributedChange(recordHome, "proj", repo); // establish baseline

  writeFileSync(join(repo, "app.txt"), "edited by hand, no task involved\n");
  detectUnattributedChange(recordHome, "proj", repo);

  const events = readEvents(recordHome);
  assert.equal(events.length, 1);
  assert.equal(events[0].name, "unattributed-change");
  assert.equal(events[0].taskId, "project:proj");
  assert.deepEqual((events[0].details as { files: string[] }).files, ["app.txt"]);
});

test("detect: a new, untracked, non-ignored file also fires (a silent add is still off the books)", () => {
  const recordHome = tempRecordHome();
  const repo = makeFixtureRepo();
  detectUnattributedChange(recordHome, "proj", repo);

  writeFileSync(join(repo, "config.json"), '{"secret":"added by an agent"}\n');
  detectUnattributedChange(recordHome, "proj", repo);

  const events = readEvents(recordHome);
  assert.equal(events.length, 1);
  assert.deepEqual((events[0].details as { files: string[] }).files, ["config.json"]);
});

test("detect: a silent commit (working tree left clean) still fires, from the moved HEAD", () => {
  const recordHome = tempRecordHome();
  const repo = makeFixtureRepo();
  detectUnattributedChange(recordHome, "proj", repo);

  writeFileSync(join(repo, "app.txt"), "changed and committed directly\n");
  commit(repo, "bypassing fabrica entirely");
  detectUnattributedChange(recordHome, "proj", repo);

  const events = readEvents(recordHome);
  assert.equal(events.length, 1);
  assert.deepEqual((events[0].details as { files: string[] }).files, ["app.txt"]);
});

test("detect: firing once resets the baseline, so the same diff never re-fires", () => {
  const recordHome = tempRecordHome();
  const repo = makeFixtureRepo();
  detectUnattributedChange(recordHome, "proj", repo);

  writeFileSync(join(repo, "app.txt"), "edited once\n");
  detectUnattributedChange(recordHome, "proj", repo);
  detectUnattributedChange(recordHome, "proj", repo);
  detectUnattributedChange(recordHome, "proj", repo);

  assert.equal(readEvents(recordHome).length, 1);
});

test("detect: a gitignored build artifact never fires (innocent noise stays quiet)", () => {
  const recordHome = tempRecordHome();
  const repo = makeFixtureRepo();
  writeFileSync(join(repo, ".gitignore"), "build/\n");
  commit(repo, "add gitignore");
  detectUnattributedChange(recordHome, "proj", repo); // establish baseline after the gitignore exists

  mkdirSync(join(repo, "build"));
  writeFileSync(join(repo, "build", "bundle.js"), "// built output\n");
  detectUnattributedChange(recordHome, "proj", repo);

  assert.deepEqual(readEvents(recordHome), []);
});

test("detect: switching to the Client's own branch resets the baseline instead of firing", () => {
  const recordHome = tempRecordHome();
  const repo = makeFixtureRepo();
  detectUnattributedChange(recordHome, "proj", repo);

  execFileSync("git", ["checkout", "-qb", "my-own-feature"], { cwd: repo });
  writeFileSync(join(repo, "app.txt"), "working on my own thing, unrelated to fabrica\n");
  detectUnattributedChange(recordHome, "proj", repo);

  assert.deepEqual(readEvents(recordHome), []);
});

test("detect: returning to a branch after a switch compares against what that branch looks like now, not before", () => {
  const recordHome = tempRecordHome();
  const repo = makeFixtureRepo();
  const original = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

  detectUnattributedChange(recordHome, "proj", repo); // baseline on the original branch, clean

  execFileSync("git", ["checkout", "-qb", "scratch"], { cwd: repo });
  detectUnattributedChange(recordHome, "proj", repo); // baseline resets to scratch, quiet

  execFileSync("git", ["checkout", "-q", original], { cwd: repo });
  detectUnattributedChange(recordHome, "proj", repo); // back on original, still exactly as left it

  assert.deepEqual(readEvents(recordHome), []);
});

test("detect: a tracked manifest-file change (e.g. a lockfile) is not special-cased — it fires like any other tracked edit", () => {
  const recordHome = tempRecordHome();
  const repo = makeFixtureRepo();
  writeFileSync(join(repo, "package-lock.json"), "{}\n");
  commit(repo, "add lockfile");
  detectUnattributedChange(recordHome, "proj", repo);

  writeFileSync(join(repo, "package-lock.json"), '{"added-by":"an off-books npm install"}\n');
  detectUnattributedChange(recordHome, "proj", repo);

  const events = readEvents(recordHome);
  assert.equal(events.length, 1);
  assert.deepEqual((events[0].details as { files: string[] }).files, ["package-lock.json"]);
});

test("detect: a project path that doesn't exist is skipped quietly, never throws", () => {
  const recordHome = tempRecordHome();
  assert.doesNotThrow(() => detectUnattributedChange(recordHome, "proj", "/no/such/path/at/all"));
  assert.deepEqual(readEvents(recordHome), []);
});
