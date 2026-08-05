// End-to-end proof of `fabrica do` exactly as main.ts/bin.mjs calls it -
// real config loading, real project resolution, a real detached process
// spawned through the real bootstrap (tsx-bootstrap.mjs) - with only the
// brain swapped for a fake, via entryScript (see spawn-detached.test.ts
// for why: this never has to invoke a real coding agent to prove the
// wiring is correct).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { runDoCommand } from "./do-command.ts";

const FAKE_ENTRY = fileURLToPath(new URL("./helpers/fake-run-task-entry.ts", import.meta.url));

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-cli-do-command-"));
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
}

test("runDoCommand: a literal project path registers a task and prints just its id", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  const io = captureIo();

  const code = await runDoCommand(["add a comment", "--project", project], {
    recordHome,
    entryScript: FAKE_ENTRY,
    ...io,
  });

  assert.equal(code, 0);
  assert.equal(io.out.length, 1);
  assert.match(io.out[0], /^\d{8}-/);
  assert.deepEqual(io.err, []);
});

test("runDoCommand: a registered project name resolves through projects.toml", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  writeFileSync(
    join(recordHome, "projects.toml"),
    `[projects.demo]\npath = "${project}"\ncheck = "./check.sh"\n`
  );
  const io = captureIo();

  const code = await runDoCommand(["add a comment", "--project", "demo"], {
    recordHome,
    entryScript: FAKE_ENTRY,
    ...io,
  });

  assert.equal(code, 0);
  assert.match(io.out[0], /^\d{8}-/);
});

test("runDoCommand: no projects.toml at all still works against a literal path (first run)", async () => {
  const recordHome = tempRecordHome(); // freshly made, nothing written into it
  const project = makeFixtureRepo("exit 0");
  const io = captureIo();

  const code = await runDoCommand(["add a comment", "--project", project], {
    recordHome,
    entryScript: FAKE_ENTRY,
    ...io,
  });

  assert.equal(code, 0);
  assert.match(io.out[0], /^\d{8}-/);
});

test("runDoCommand: bad usage refuses with exact instructions and exit 1, nothing spawned", async () => {
  const recordHome = tempRecordHome();
  const io = captureIo();

  const code = await runDoCommand(["fix the bug"], { recordHome, entryScript: FAKE_ENTRY, ...io });

  assert.equal(code, 1);
  assert.deepEqual(io.out, []);
  assert.equal(io.err.length, 1);
  assert.match(io.err[0], /--project/);
});

test("runDoCommand: a registered project with no check command refuses before spawning", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  writeFileSync(join(recordHome, "projects.toml"), `[projects.demo]\npath = "${project}"\n`);
  const io = captureIo();

  const code = await runDoCommand(["add a comment", "--project", "demo"], {
    recordHome,
    entryScript: FAKE_ENTRY,
    ...io,
  });

  assert.equal(code, 1);
  assert.match(io.err[0], /check command/);
  assert.deepEqual(io.out, []);
});

test("runDoCommand: a nonexistent path that isn't a registered name refuses with exact instructions", async () => {
  const recordHome = tempRecordHome();
  const io = captureIo();

  const code = await runDoCommand(["fix it", "--project", "/nowhere/at/all"], {
    recordHome,
    entryScript: FAKE_ENTRY,
    ...io,
  });

  assert.equal(code, 1);
  assert.match(io.err[0], /\[projects\.<name>\]/);
});

test("runDoCommand: a malformed projects.toml is a real refusal, not silently ignored", async () => {
  const recordHome = tempRecordHome();
  writeFileSync(join(recordHome, "projects.toml"), "this is not valid toml [[[");
  const io = captureIo();

  const code = await runDoCommand(["fix it", "--project", "/whatever"], {
    recordHome,
    entryScript: FAKE_ENTRY,
    ...io,
  });

  assert.equal(code, 1);
  assert.match(io.err[0], /projects\.toml/);
});
