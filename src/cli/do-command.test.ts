// End-to-end proof of `fabrica do` exactly as main.ts/bin.mjs calls it -
// real config loading, real project resolution, a real detached process
// spawned through the real bootstrap (tsx-bootstrap.mjs) - with only the
// brain swapped for a fake, via entryScript (see spawn-detached.test.ts
// for why: this never has to invoke a real coding agent to prove the
// wiring is correct).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFixtureRepo, pushToOrigin } from "../../contract/helpers/fixture.ts";
import { fixtureInspector } from "../../contract/helpers/fake-inspector.ts";
import { createForeman } from "../index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { readEventsForTask, readTaskFile } from "../record/index.ts";
import { addReaderToHome, READER_TOML } from "../reader/helpers/configured-home.ts";
import { runDoCommand } from "./do-command.ts";

const FAKE_ENTRY = fileURLToPath(new URL("./helpers/fake-run-task-entry.ts", import.meta.url));

/** A record home with a code reader configured in it, since `fabrica
 * do` refuses an inspected project without one (inspector issue #34) -
 * so every test below whose subject is something else gets past that
 * gate. The gate's own tests build their homes by hand. */
function tempRecordHome(): string {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-cli-do-command-"));
  addReaderToHome(recordHome);
  return recordHome;
}

/** A record home with no reader configured at all - what a machine
 * looks like before the Client has named one. */
function unconfiguredRecordHome(): string {
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

// "Make every pull request it opens close its issue on merge": the
// chat agent's explicit alternative to an "Issue #N:" text prefix is a
// CLI flag, which has to survive the detached-process boundary
// (spawn-detached.ts's argv, picked back up by the entry script) the
// same way <task text> and --project already do.
test("runDoCommand: --issue <N> survives the detached process and lands on the task's own record", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  const io = captureIo();

  const code = await runDoCommand(["add a comment", "--project", project, "--issue", "186"], {
    recordHome,
    entryScript: FAKE_ENTRY,
    ...FAST_ASK_WAIT,
    ...io,
  });

  assert.equal(code, 0);
  const taskId = io.out[0];
  assert.equal(readTaskFile(recordHome, taskId, "issue"), "186");
  // And the issue's own words, read at registration in that detached
  // process and frozen on the record (src/foreman/task-issue.ts) - a
  // fixture issue here, since the entry script hands over a fake reader
  // exactly as it does for the Inspector and the worker's box.
  assert.match(readTaskFile(recordHome, taskId, "issue.md") ?? "", /#186: Fixture issue/);
});

/** `runDoCommand` returns as soon as the ask-or-proceed step is decided
 * (issue #123) - the attempt itself is still running in the detached
 * process - so a test about what lands on a receipt has to wait for one
 * to exist. */
async function waitForReceipts(recordHome: string, taskId: string) {
  const foreman = createForeman({ recordHome });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const receipts = await foreman.receiptsOf(taskId);
    if (receipts.length > 0) return receipts;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no receipt was ever recorded for ${taskId}`);
}

// Issue #184's own definition of done: "a task run with --model shows
// both the declared and the actual model". The declaration has to
// survive the same detached-process boundary --issue does, and reach
// both the task's own record (for every later round) and every receipt
// (beside the model that really ran).
test("runDoCommand: --model survives the detached process and lands on the record and the receipt", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  const io = captureIo();

  const code = await runDoCommand(["add a comment", "--project", project, "--model", "small-5"], {
    recordHome,
    entryScript: FAKE_ENTRY,
    ...FAST_ASK_WAIT,
    ...io,
  });

  assert.equal(code, 0);
  const taskId = io.out[0];
  assert.equal(readTaskFile(recordHome, taskId, "model.json"), JSON.stringify({ declaredModel: "small-5", modelSource: "flag" }));

  const receipts = await waitForReceipts(recordHome, taskId);
  assert.equal(receipts[0].declaredModel, "small-5");
  assert.equal(receipts[0].modelSource, "flag");
  // The fake entry hands the declared model to its fake brain, which is
  // what the real entry does with the real adapter - so the model that
  // ran is a real name, and never the word this issue removed.
  assert.equal(receipts[0].model, "small-5");
  assert.notEqual(receipts[0].model, "default");
});

test("runDoCommand: with no --model and no project setting, the record says nothing was declared", async () => {
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
  const receipts = await waitForReceipts(recordHome, io.out[0]);
  assert.equal(receipts[0].declaredModel, null);
  assert.equal(receipts[0].modelSource, "default");
  // The fake brain's own label stands in for the model that ran, the
  // way a real adapter's reported model would - "default" never appears.
  assert.notEqual(receipts[0].model, "default");
});

test("runDoCommand: --issue must be a positive integer", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  const io = captureIo();

  const code = await runDoCommand(["add a comment", "--project", project, "--issue", "0"], {
    recordHome,
    entryScript: FAKE_ENTRY,
    ...FAST_ASK_WAIT,
    ...io,
  });

  assert.equal(code, 1);
  assert.equal(io.out.length, 0);
  assert.ok(io.err[0].includes("--issue"));
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
  assert.deepEqual(events, ["task-received", "ask-cost-recorded", "questions-asked"]);
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
    `${READER_TOML}\n[projects.demo]\npath = "${project}"\ncheck = "./check.sh"\n`
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

// This used to read "no projects.toml at all still works against a
// literal path (first run)", and it genuinely did. Inspector issue #34
// changed that, deliberately and visibly: every task's diff is read
// after Inspector's green, the reader is named in projects.toml, and the
// Client's ruling is to refuse at task start with the exact lines to
// add. So a record home with no projects.toml can no longer start an
// inspected task - a literal `--project` path included - and the
// refusal is the whole point rather than a side effect.
//
// The first run against a literal path still needs no *project entry*,
// which is what that property was really protecting: the test below
// ("a literal project path registers a task") has none and passes. What
// it now needs is a `[reader]`.
test("runDoCommand: a record home with no reader configured refuses, with the lines to add", async () => {
  const recordHome = unconfiguredRecordHome(); // freshly made, nothing written into it
  const project = makeFixtureRepo("exit 0");
  const io = captureIo();

  const code = await runDoCommand(["add a comment", "--project", project], {
    recordHome,
    entryScript: FAKE_ENTRY,
    ...FAST_ASK_WAIT,
    ...io,
  });

  assert.equal(code, 1);
  assert.deepEqual(io.out, [], "a refused task must not print an id");
  assert.match(io.err.join("\n"), /no code reader is configured/);
  assert.match(io.err.join("\n"), /\[reader\]/);
  // Nothing was registered: the refusal costs nothing, which is the
  // reason it lives here rather than inside the round.
  assert.equal(existsSync(join(recordHome, "tasks")), false);
});

test("runDoCommand: a reader named in projects.toml is enough - no project entry needed", async () => {
  const recordHome = tempRecordHome(); // the [reader] table and its credentials only
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
  writeFileSync(join(recordHome, "projects.toml"), `${READER_TOML}\n[projects.demo]\npath = "${project}"\n`);
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
  writeFileSync(join(recordHome, "projects.toml"), `${READER_TOML}\n[caps]\nperDayUsd = 100\n`);
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
  writeFileSync(join(recordHome, "projects.toml"), `${READER_TOML}\n[caps]\nperDayUsd = 0\n`);
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

// This file's two self-tested cases below reach a failure that only
// exists behind `fabrica do`'s own up-front "is this project set up for
// Fabrica" gate - a project with no .inspector.json is now refused
// before it is ever registered (see the gate's own tests further down).
// They are about what the *detached task* reports once it has started,
// so they say so explicitly rather than being rewritten into a
// different failure: PAST_SETUP_GATE skips exactly that one check and
// nothing else.
const PAST_SETUP_GATE = { setUpRefusal: () => null };

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
  pushToOrigin(project);
  const io = captureIo();

  const code = await runDoCommand(["small change", "--project", project], {
    recordHome,
    entryScript: FAKE_ENTRY,
    ...FAST_ASK_WAIT,
    ...PAST_SETUP_GATE,
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
  pushToOrigin(project);
  const io = captureIo();

  await runDoCommand(["small change", "--project", project], {
    recordHome,
    entryScript: FAKE_ENTRY,
    ...FAST_ASK_WAIT,
    ...PAST_SETUP_GATE,
    ...io,
  });
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

// The up-front setup gate: a project whose base commit carries no
// .inspector.json has nothing saying how its work should be checked, so
// a task on it could never be verified - and a task that cannot be
// verified should cost nothing at all. Refused before registration, so
// there is no task id, no record, and no detached process.
test("runDoCommand: a project with no .inspector.json at its base commit is refused before anything is registered", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0", { inspector: false });
  const io = captureIo();

  const code = await runDoCommand(["small change", "--project", project], {
    recordHome,
    entryScript: FAKE_ENTRY,
    ...FAST_ASK_WAIT,
    ...io,
  });

  assert.equal(code, 1);
  assert.deepEqual(io.out, [], "nothing was registered, so there is no task id to print");
  assert.equal(
    io.err.join("\n"),
    `fabrica do: this project isn't set up for Fabrica yet: run fabrica register ${project} --check ... --image ...`
  );
  assert.equal(existsSync(join(recordHome, "events.jsonl")), false, "no event was recorded for a task never started");
});

// It is the *base* commit that decides, which is origin's default
// branch - not whatever the Client's local checkout happens to hold.
test("runDoCommand: .inspector.json only in the local checkout is not set up - the base commit is what counts", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0", { inspector: false });
  writeFileSync(join(project, ".inspector.json"), '{"check":"./check.sh","image":"alpine"}\n');
  const io = captureIo();

  const code = await runDoCommand(["small change", "--project", project], {
    recordHome,
    entryScript: FAKE_ENTRY,
    ...FAST_ASK_WAIT,
    ...io,
  });

  assert.equal(code, 1);
  assert.match(io.err.join("\n"), /isn't set up for Fabrica yet/);
});

// "Could not find out" is not "not set up": a project with no origin at
// all gets the real downstream git error, which says far more than a
// misdirected instruction to run `fabrica register` would.
test("runDoCommand: a project whose setup state cannot be determined is not refused by the gate", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0", { inspector: false, origin: false });
  const io = captureIo();

  const code = await runDoCommand(["small change", "--project", project], {
    recordHome,
    entryScript: FAKE_ENTRY,
    ...FAST_ASK_WAIT,
    ...io,
  });

  assert.equal(code, 1, "it still fails - just not with the gate's message");
  assert.doesNotMatch(io.err.join("\n"), /isn't set up for Fabrica yet/);
  assert.equal(io.out.length, 1, "it got as far as registering, so there is a task id and a record to read");
});

// The second half of the same gate: a project that asks for its test
// changes to be judged by a model, with no reviewer configured to do the
// judging, is refused in exactly the same place and for exactly the same
// reason - nothing can properly judge the work, so no worker should run
// and no money should be spent.
test("runDoCommand: testPaths declared with no [reviewer] configured is refused before anything is registered", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  writeFileSync(
    join(project, ".inspector.json"),
    '{"check":"./check.sh","image":"alpine","testPaths":"*.test.ts"}\n'
  );
  execFileSync("git", ["add", "-A"], { cwd: project });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "judge my tests"], { cwd: project });
  pushToOrigin(project);
  const io = captureIo();

  const code = await runDoCommand(["small change", "--project", project], {
    recordHome,
    entryScript: FAKE_ENTRY,
    ...FAST_ASK_WAIT,
    ...io,
  });

  assert.equal(code, 1);
  assert.deepEqual(io.out, [], "nothing was registered, so there is no task id to print");
  assert.match(io.err.join("\n"), /testPaths/);
  assert.match(io.err.join("\n"), /\[reviewer\]/);
  assert.equal(existsSync(join(recordHome, "events.jsonl")), false, "no event was recorded for a task never started");
});

// The ordinary case, stated as its own test so the gate above can never
// quietly widen into "every project needs a reviewer".
test("runDoCommand: a project that declares no testPaths needs no reviewer at all", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  const io = captureIo();

  const code = await runDoCommand(["small change", "--project", project], {
    recordHome,
    entryScript: FAKE_ENTRY,
    ...FAST_ASK_WAIT,
    ...io,
  });

  assert.equal(code, 0);
  assert.equal(io.out.length, 1, "it got past the gate and registered a task");
  assert.doesNotMatch(io.err.join("\n"), /\[reviewer\]/);
});
