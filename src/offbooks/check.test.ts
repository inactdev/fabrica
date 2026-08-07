import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { readEvents } from "../record/index.ts";
import { checkForOffBooksChanges } from "./check.ts";

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-offbooks-check-"));
}

function writeProjectsToml(recordHome: string, projects: Record<string, string>): void {
  const lines = Object.entries(projects).map(([name, path]) => `[projects.${name}]\npath = "${path}"\n`);
  writeFileSync(join(recordHome, "projects.toml"), lines.join("\n"));
}

test("checkForOffBooksChanges: no projects.toml at all never throws and logs nothing", () => {
  const recordHome = tempRecordHome();
  assert.doesNotThrow(() => checkForOffBooksChanges(recordHome));
  assert.deepEqual(readEvents(recordHome), []);
});

test("checkForOffBooksChanges: malformed projects.toml never throws and logs nothing", () => {
  const recordHome = tempRecordHome();
  writeFileSync(join(recordHome, "projects.toml"), "this is not valid toml [[[");
  assert.doesNotThrow(() => checkForOffBooksChanges(recordHome));
  assert.deepEqual(readEvents(recordHome), []);
});

test("checkForOffBooksChanges: checks every registered project, firing only for the one that actually changed", () => {
  const recordHome = tempRecordHome();
  const quiet = makeFixtureRepo();
  const changed = makeFixtureRepo();
  writeProjectsToml(recordHome, { quiet, changed });

  checkForOffBooksChanges(recordHome); // establishes baselines for both

  writeFileSync(join(changed, "app.txt"), "edited outside any task\n");
  checkForOffBooksChanges(recordHome);

  const events = readEvents(recordHome).filter((e) => e.name === "unattributed-change");
  assert.equal(events.length, 1);
  assert.equal(events[0].taskId, "project:changed");
});

test("checkForOffBooksChanges: one project's checkout going missing never stops the others from being checked", () => {
  const recordHome = tempRecordHome();
  const changed = makeFixtureRepo();
  writeProjectsToml(recordHome, { gone: "/no/such/path/anywhere", changed });

  checkForOffBooksChanges(recordHome);
  writeFileSync(join(changed, "app.txt"), "edited outside any task\n");
  checkForOffBooksChanges(recordHome);

  const events = readEvents(recordHome).filter((e) => e.name === "unattributed-change");
  assert.equal(events.length, 1);
  assert.equal(events[0].taskId, "project:changed");
});

test("checkForOffBooksChanges: a delivered task's branch being merged by hand is not exempted (documented, accepted tradeoff)", () => {
  // See src/offbooks/README.md — this net compares the registered
  // project's checkout across commands, not against Fabrica's own task
  // history, so merging a fabrica/<id> branch in still fires: it's still
  // true that this checkout's tracked content changed outside of any
  // command the net itself ran.
  const recordHome = tempRecordHome();
  const repo = makeFixtureRepo();
  writeProjectsToml(recordHome, { proj: repo });
  checkForOffBooksChanges(recordHome);

  const original = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  execFileSync("git", ["checkout", "-qb", "fabrica/example-task"], { cwd: repo });
  writeFileSync(join(repo, "app.txt"), "delivered work\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "delivered"], { cwd: repo });
  execFileSync("git", ["checkout", "-q", original], { cwd: repo });
  execFileSync("git", ["merge", "-q", "--no-edit", "fabrica/example-task"], { cwd: repo });

  checkForOffBooksChanges(recordHome);

  const events = readEvents(recordHome).filter((e) => e.name === "unattributed-change");
  assert.equal(events.length, 1);
});
