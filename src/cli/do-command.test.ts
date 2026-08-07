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
import { readEventsForTask } from "../record/index.ts";
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

// Every test below passes a short askTimeoutMs/askPollMs so a slow or
// missing ask-outcome signal never makes this suite itself slow - the
// fake brain's ask() resolves instantly, so a real signal always lands
// well within these bounds; only the "no work" test below relies on the
// timeout actually being hit.
const FAST_ASK_WAIT = { askTimeoutMs: 5_000, askPollMs: 20 };

test("runDoCommand: a literal project path registers a task and prints just its id", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  const io = captureIo();

  const code = await runDoCommand(["add a comment", "--project", project], {
    recordHome,
    entryScript: FAKE_ENTRY,
    ...FAST_ASK_WAIT,
    ...io,
  });

  assert.equal(code, 0);
  assert.equal(io.out.length, 1);
  assert.match(io.out[0], /^\d{8}-/);
  assert.deepEqual(io.err, []);
});

// Issue #8's own definition of done, scenario 1, exercised end to end
// through the real CLI: a materially ambiguous task prints numbered
// questions and stops.
test("runDoCommand: a materially ambiguous task prints numbered questions and stops", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  const io = captureIo();

  const code = await runDoCommand(["ASK_ME_SOMETHING build an app", "--project", project], {
    recordHome,
    entryScript: FAKE_ENTRY,
    ...FAST_ASK_WAIT,
    ...io,
  });

  assert.equal(code, 0);
  assert.deepEqual(io.err, []);
  assert.match(io.out[0], /^\d{8}-/);
  const taskId = io.out[0];
  assert.match(io.out.join("\n"), /materially ambiguous/);
  assert.match(io.out.join("\n"), /1\. What database should this use\?/);
  assert.match(io.out.join("\n"), /2\. Should it support multi-tenancy\?/);
  assert.match(io.out.join("\n"), new RegExp(`fabrica answer ${taskId} -m "<text>"`));

  // No worker ran - nothing beyond registration and the ask itself is on
  // the record yet.
  const events = readEventsForTask(recordHome, taskId).map((e) => e.name);
  assert.deepEqual(events, ["task-received", "questions-asked"]);
});

// Issue #8's own definition of done, scenario 3, exercised end to end:
// an unambiguous task is unaffected and still delivers in the
// background exactly as before.
test("runDoCommand: an unambiguous task is unaffected - it still delivers in the background", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  const io = captureIo();

  const code = await runDoCommand(["add a comment", "--project", project], {
    recordHome,
    entryScript: FAKE_ENTRY,
    ...FAST_ASK_WAIT,
    ...io,
  });

  assert.equal(code, 0);
  assert.equal(io.out.length, 1, "still exactly one line: just the task id, no questions");
  const taskId = io.out[0];

  const deadline = Date.now() + 10_000;
  let delivered = false;
  while (Date.now() < deadline) {
    if (readEventsForTask(recordHome, taskId).some((e) => e.name === "delivered")) {
      delivered = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(delivered, "the unambiguous task never delivered in the background");
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
    ...FAST_ASK_WAIT,
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
    ...FAST_ASK_WAIT,
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
