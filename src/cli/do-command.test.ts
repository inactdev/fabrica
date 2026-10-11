// End-to-end proof of `fabrica do` exactly as main.ts/bin.mjs calls it -
// real config loading, real project resolution, a real detached process
// spawned through the real bootstrap (tsx-bootstrap.mjs) - with only the
// brain swapped for a fake, via entryScript (see spawn-detached.test.ts
// for why: this never has to invoke a real coding agent to prove the
// wiring is correct).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { fixtureInspector } from "../../contract/helpers/fake-inspector.ts";
import { createForeman } from "../index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
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

// A short poll keeps this suite fast; there is no cutoff to tune any more
// (Client ruling 2026-10-10, #73) - every test below reaches a real outcome.
const FAST_ASK_WAIT = { askPollMs: 20 };

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
//
// Client ruling (issue #8 follow-up): stdout stays exactly the task id,
// one line, nothing else, in every case - including the asking one -
// so `id=$(fabrica do "..." --project foo) || exit 1` (src/cli/README.md)
// keeps working verbatim. The explanation and questions are guidance for
// the Client's own screen, so they go to stderr instead; no separate
// exit code for this case, since restoring the documented stdout
// contract already covers scripting.
test("runDoCommand: a materially ambiguous task's stdout is exactly the task id, nothing else", async () => {
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
  assert.equal(io.out.length, 1, "stdout must be exactly one line, the id, same as any other outcome");
  assert.match(io.out[0], /^\d{8}-/);
  const taskId = io.out[0];

  // No worker ran - nothing beyond registration and the ask itself is on
  // the record yet.
  const events = readEventsForTask(recordHome, taskId).map((e) => e.name);
  assert.deepEqual(events, ["task-received", "questions-asked"]);
});

test("runDoCommand: a materially ambiguous task prints the numbered questions and how to answer them, to stderr", async () => {
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
  const taskId = io.out[0];
  assert.match(io.err.join("\n"), /materially ambiguous/);
  assert.match(io.err.join("\n"), /1\. What database should this use\?/);
  assert.match(io.err.join("\n"), /2\. Should it support multi-tenancy\?/);
  assert.match(io.err.join("\n"), new RegExp(`fabrica answer ${taskId} -m "<text>"`));
});

// Client ruling, issue #8 follow-up: a task that fails before any work
// starts (brain.ask() throwing - the reference adapter's documented
// credential gap is today's live path) must exit non-zero with the real
// reason, so `id=$(fabrica do "..." --project foo) || exit 1`
// (src/cli/README.md) actually catches it, instead of reading a
// success code off a task that never got past its own first step.
test("runDoCommand: a task whose ask() fails prints the real reason and exits non-zero", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  const io = captureIo();

  const code = await runDoCommand(["ASK_FAILS_SOMETHING build an app", "--project", project], {
    recordHome,
    entryScript: FAKE_ENTRY,
    ...FAST_ASK_WAIT,
    ...io,
  });

  assert.equal(code, 1);
  assert.equal(io.out.length, 1, "stdout still carries only the task id - the task was genuinely registered");
  assert.match(io.out[0], /^\d{8}-/);
  const taskId = io.out[0];
  assert.match(io.err.join("\n"), /the task failed before any work started/);
  assert.match(io.err.join("\n"), /simulated: the brain is unreachable/);

  const events = readEventsForTask(recordHome, taskId).map((e) => e.name);
  assert.deepEqual(events, ["task-received", "ask-failed"]);
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

// Issue #11, Client ruling 2026-10-08, part 1: an unknown cost under a
// cap is a non-zero exit naming the unmeasured task - not a warning, not
// a log line, and not a refusal that leaves the operator guessing which
// task to look at.
test("runDoCommand: an unknown cost under a cap exits non-zero, naming the unmeasured task", async () => {
  const recordHome = tempRecordHome();
  writeFileSync(join(recordHome, "projects.toml"), "[caps]\nperDayUsd = 100\n");
  const project = makeFixtureRepo("exit 0");
  const unmeasured = await createForeman({ recordHome, caps: { perDayUsd: 100 }, inspector: fixtureInspector() }).do("unmeasured", {
    project,
    brain: fakeBrain({ costUsd: null }),
  });
  const io = captureIo();

  const code = await runDoCommand(["any task at all", "--project", project], {
    recordHome,
    entryScript: FAKE_ENTRY,
    ...FAST_ASK_WAIT,
    ...io,
  });

  assert.equal(code, 1, "fabrica do proceeded past an unmeasured spend");
  assert.equal(io.out.length, 1, "stdout must still be exactly the (refused) task's id");
  const stderr = io.err.join("\n");
  assert.match(stderr, /SPEND UNKNOWN - tasks blocked/);
  assert.ok(stderr.includes(unmeasured.id), `the refusal does not name the unmeasured task ${unmeasured.id}: ${stderr}`);
  assert.match(stderr, new RegExp(`fabrica cost ${unmeasured.id} <usd>`));
  assert.ok(readEventsForTask(recordHome, io.out[0]).some((e) => e.name === "cap-refused"));
});

test("runDoCommand: a daily-cap refusal exits non-zero with the numbers", async () => {
  const recordHome = tempRecordHome();
  writeFileSync(join(recordHome, "projects.toml"), "[caps]\nperDayUsd = 0\n");
  const project = makeFixtureRepo("exit 0");
  const io = captureIo();

  const code = await runDoCommand(["any task at all", "--project", project], {
    recordHome,
    entryScript: FAKE_ENTRY,
    ...FAST_ASK_WAIT,
    ...io,
  });

  assert.equal(code, 1);
  assert.match(io.err.join("\n"), /\$0\.00/);
});

// #73, Client ruling 2026-10-10: a start that fails after registration is
// never silent - fabrica do waits for the real outcome and, on a failure,
// prints the message and exits 1, instead of timing out into "proceeding".
test("runDoCommand: a task that fails before any work starts prints why and exits 1", async () => {
  const recordHome = tempRecordHome();
  // Self-tested (no .inspector.json) with no check.sh: refused once the
  // ProductionLine is cut, before work-started.
  const project = makeFixtureRepo("exit 0", { inspector: false });
  execFileSync("git", ["rm", "-q", "check.sh"], { cwd: project });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "no check"], { cwd: project });
  const io = captureIo();

  const code = await runDoCommand(["small change", "--project", project], {
    recordHome,
    entryScript: FAKE_ENTRY,
    ...FAST_ASK_WAIT,
    ...io,
  });

  assert.equal(code, 1, "a task that never started was reported as a success");
  assert.equal(io.out.length, 1, "stdout must still be exactly the task id");
  assert.match(io.err.join("\n"), /check\.sh/);
  assert.ok(readEventsForTask(recordHome, io.out[0]).some((e) => e.name === "task-failed"));
});

// Every cli.log line carries a timestamp and the task id, so a line can be
// tied back to its task long after the terminal is gone.
test("runDoCommand: every cli.log line carries a timestamp and the task id", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0", { inspector: false });
  execFileSync("git", ["rm", "-q", "check.sh"], { cwd: project });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "no check"], { cwd: project });
  const io = captureIo();

  await runDoCommand(["small change", "--project", project], { recordHome, entryScript: FAKE_ENTRY, ...FAST_ASK_WAIT, ...io });
  const taskId = io.out[0];
  // The child writes its last line as it exits; give it a moment.
  await new Promise((r) => setTimeout(r, 500));

  const lines = readFileSync(join(recordHome, "cli.log"), "utf8").split("\n").filter((l) => l.length > 0);
  assert.ok(lines.length > 0, "nothing was written to cli.log");
  for (const line of lines) {
    assert.match(line, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /, `no timestamp: ${line}`);
    assert.ok(line.includes(` ${taskId} `), `no task id: ${line}`);
  }
});
