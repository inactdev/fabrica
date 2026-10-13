// runVerdictCommand end to end - the CLI's own argument parsing,
// config-free record home, and message wording, for every ruling.
// "accept"/"wrong" are instant and still run synchronously. A "fix"
// (issue #123) returns immediately instead, handing the round to a
// detached process (the same mechanism `fabrica do` uses) - the fix
// mechanism itself (session resume, round counting) is proven in
// src/foreman/verdict.test.ts; what's proven here is that this command
// hands off and returns before the round finishes, that the round still
// completes and delivers in the background, and the line the Client
// reads back. The refusing "fix" cases below still stop synchronously,
// before anything is handed off - "fix" has no attempt budget of its
// own any more (issue #65), so what's left to refuse it up front is a
// missing note or a task with no delivery to reopen; a failure from
// inside the round itself (the worker, the ProductionLine) instead
// lands on the record as "task-failed", discovered the same way any
// other background failure is.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "../index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { runVerdictCommand } from "./verdict-command.ts";
import { fixtureInspector } from "../../contract/helpers/fake-inspector.ts";
import { readEventsForTask } from "../record/index.ts";

const FAKE_VERDICT_FIX_ENTRY = fileURLToPath(new URL("./helpers/fake-verdict-fix-entry.ts", import.meta.url));

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-cli-verdict-command-"));
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
}

async function waitForSecondDelivery(recordHome: string, taskId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const delivered = readEventsForTask(recordHome, taskId).filter((e) => e.name === "delivered");
    if (delivered.length >= 2) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail("the fix round never delivered a second time");
}

test("runVerdictCommand: accept closes the task and reports so", async () => {
  const recordHome = tempRecordHome();
  const task = await createForeman({ recordHome, inspector: fixtureInspector() }).do("small change", {
    project: makeFixtureRepo("exit 0"),
    brain: fakeBrain(),
  });
  const io = captureIo();

  const code = await runVerdictCommand([task.id, "accept", "-m", "looks right"], { recordHome, ...io });

  assert.equal(code, 0);
  assert.deepEqual(io.err, []);
  assert.equal(io.out.length, 1);
  assert.match(io.out[0], new RegExp(`^accept recorded: ${task.id} is closed\\.$`));

  const mine = (await createForeman({ recordHome, inspector: fixtureInspector() }).status()).find((t) => t.id === task.id);
  assert.equal(mine?.state, "closed");
});

test("runVerdictCommand: accept prints the reported pull request url exactly once", async () => {
  const recordHome = tempRecordHome();
  const inspector = {
    async inspect() {
      return { verdict: "green" as const, report: "ok", prUrl: "https://example.test/pulls/3" };
    },
  };
  const task = await createForeman({ recordHome, inspector }).do("small change", {
    project: makeFixtureRepo("exit 0"),
    brain: fakeBrain(),
  });
  const io = captureIo();

  const code = await runVerdictCommand([task.id, "accept", "-m", "looks right"], { recordHome, ...io });

  assert.equal(code, 0);
  assert.equal(io.out.length, 1);
  const occurrences = io.out[0].split("https://example.test/pulls/3").length - 1;
  assert.equal(occurrences, 1, `expected the url exactly once, got: ${io.out[0]}`);
});

// Negative first (companion to the above): "wrong" never prints a pull
// request url, even when Inspector reported one - the task scopes the
// print to "after accept" specifically.
test("runVerdictCommand: wrong never prints a pull request url even when Inspector reported one", async () => {
  const recordHome = tempRecordHome();
  const inspector = {
    async inspect() {
      return { verdict: "green" as const, report: "ok", prUrl: "https://example.test/pulls/3" };
    },
  };
  const task = await createForeman({ recordHome, inspector }).do("small change", {
    project: makeFixtureRepo("exit 0"),
    brain: fakeBrain(),
  });
  const io = captureIo();

  const code = await runVerdictCommand([task.id, "wrong", "-m", "not what I asked for"], { recordHome, ...io });

  assert.equal(code, 0);
  assert.doesNotMatch(io.out[0], /pull request/);
});

test("runVerdictCommand: wrong closes the task and reports so", async () => {
  const recordHome = tempRecordHome();
  const task = await createForeman({ recordHome, inspector: fixtureInspector() }).do("small change", {
    project: makeFixtureRepo("exit 0"),
    brain: fakeBrain(),
  });
  const io = captureIo();

  const code = await runVerdictCommand([task.id, "wrong", "-m", "not what I asked for"], { recordHome, ...io });

  assert.equal(code, 0);
  assert.match(io.out[0], new RegExp(`^wrong recorded: ${task.id} is closed\\.$`));

  const verdictEvent = (await createForeman({ recordHome, inspector: fixtureInspector() }).events(task.id))
    .filter((e) => e.name === "verdict-recorded")
    .at(-1);
  assert.equal(
    (verdictEvent?.details as { note?: string } | undefined)?.note,
    "not what I asked for",
    "the -m note reaches the record verbatim"
  );
});

// Issue #123's own definition of done for this command: it returns
// before the fix round finishes, and the round still completes and
// delivers in the background.
test("runVerdictCommand: fix returns before the round finishes, and the round still delivers", async () => {
  const recordHome = tempRecordHome();
  const task = await createForeman({ recordHome, inspector: fixtureInspector() }).do("small change", {
    project: makeFixtureRepo("exit 0"),
    brain: fakeBrain(),
    attempts: 1,
  });
  const io = captureIo();

  const started = Date.now();
  const code = await runVerdictCommand([task.id, "fix", "-m", "wrong button spot"], {
    recordHome,
    entryScript: FAKE_VERDICT_FIX_ENTRY,
    ...io,
  });
  const elapsedMs = Date.now() - started;

  assert.equal(code, 0, io.err[0]);
  assert.ok(elapsedMs < 2_000, `expected to return quickly (before the round runs), took ${elapsedMs}ms`);
  assert.deepEqual(io.err, []);
  assert.deepEqual(io.out, [
    `fix round 1 recorded: ${task.id} is running again with your note in the background. ` +
      `Follow progress with \`fabrica log ${task.id}\` or \`fabrica watch ${task.id}\`.`,
  ]);

  // The verdict itself is already on the record (recorded synchronously,
  // in the foreground) ...
  const verdictEvent = (await createForeman({ recordHome, inspector: fixtureInspector() }).events(task.id))
    .filter((e) => e.name === "verdict-recorded")
    .at(-1);
  assert.equal((verdictEvent?.details as { note?: string } | undefined)?.note, "wrong button spot");

  // ... but the round itself has not run yet - spawning and loading a
  // real separate process takes measurably longer than this command's
  // own synchronous handoff, so the fix round's own delivery is not here
  // the instant this call returns.
  assert.equal(
    readEventsForTask(recordHome, task.id).filter((e) => e.name === "delivered").length,
    1,
    "the fix round must not have finished before runVerdictCommand returned"
  );

  await waitForSecondDelivery(recordHome, task.id);

  const mine = (await createForeman({ recordHome, inspector: fixtureInspector() }).status()).find((t) => t.id === task.id);
  assert.notEqual(mine?.state, "closed", "a fix leaves the task open for the Client's next word");
});

test("runVerdictCommand: bad usage refuses with exact instructions and exit 1", async () => {
  const recordHome = tempRecordHome();
  const io = captureIo();

  const code = await runVerdictCommand(["some-task"], { recordHome, ...io });

  assert.equal(code, 1);
  assert.deepEqual(io.out, []);
  assert.equal(io.err.length, 1);
  assert.match(io.err[0], /<accept\|fix\|wrong>/);
});

test("runVerdictCommand: an unknown task id refuses with the Foreman's own message", async () => {
  const recordHome = tempRecordHome();
  const io = captureIo();

  const code = await runVerdictCommand(["no-such-task", "accept"], { recordHome, ...io });

  assert.equal(code, 1);
  assert.deepEqual(io.out, []);
  assert.match(io.err[0], /no task "no-such-task"/);
});

// A failure that only shows up once the fix round actually runs (here:
// reopenProductionLine refusing to reuse a worktree path something else
// already occupies) is handed off exactly like a successful fix would
// be - this command has already returned 0 by the time it happens, and
// it lands on the record as "task-failed" instead of a stack trace on
// this command's own stderr.
test("runVerdictCommand: a ProductionLine refusal inside a fix round lands on the record, not on this command's exit code", async () => {
  const recordHome = tempRecordHome();
  const task = await createForeman({ recordHome, inspector: fixtureInspector() }).do("small change", {
    project: makeFixtureRepo("exit 0"),
    brain: fakeBrain(),
  });
  // Something already sitting where a fix round would reopen the line -
  // reopenProductionLine refuses to reuse or overwrite it, with a
  // LineError, before any worker runs.
  mkdirSync(join(recordHome, "tasks", task.id, "worktree"), { recursive: true });
  const io = captureIo();

  const code = await runVerdictCommand([task.id, "fix", "-m", "one more pass"], {
    recordHome,
    entryScript: FAKE_VERDICT_FIX_ENTRY,
    ...io,
  });

  assert.equal(code, 0, "handing off a fix round that will fail is still a successful handoff");
  assert.deepEqual(io.err, []);

  const deadline = Date.now() + 10_000;
  let failed = false;
  while (Date.now() < deadline) {
    if (readEventsForTask(recordHome, task.id).some((e) => e.name === "task-failed")) {
      failed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(failed, "the fix round's own failure never reached the record");
  const failure = readEventsForTask(recordHome, task.id).find((e) => e.name === "task-failed");
  assert.match((failure?.details as { message?: string }).message ?? "", /workspace already exists/i);
});

// The point isn't this particular failure - it's that the command owns
// no list of error types to keep up to date. This path (accept) is still
// entirely synchronous, so a lower-layer error still reaches the Client
// directly rather than only through the record.
test("runVerdictCommand: an error from a layer it knows nothing about is still printed, not thrown", async () => {
  const recordHome = tempRecordHome();
  const task = await createForeman({ recordHome, inspector: fixtureInspector() }).do("small change", {
    project: makeFixtureRepo("exit 0"),
    brain: fakeBrain(),
  });
  // A directory where the task's verdict file has to be written: the
  // record layer's own append fails, with a plain filesystem error.
  mkdirSync(join(recordHome, "tasks", task.id, "verdict"), { recursive: true });
  const io = captureIo();

  const code = await runVerdictCommand([task.id, "accept", "-m", "looks right"], { recordHome, ...io });

  assert.equal(code, 1);
  assert.deepEqual(io.out, []);
  assert.equal(io.err.length, 1);
  assert.match(io.err[0], /EISDIR|illegal operation on a directory/i);
});

test("runVerdictCommand: a verdict on an already-closed task refuses", async () => {
  const recordHome = tempRecordHome();
  const task = await createForeman({ recordHome, inspector: fixtureInspector() }).do("small change", {
    project: makeFixtureRepo("exit 0"),
    brain: fakeBrain(),
  });
  await createForeman({ recordHome, inspector: fixtureInspector() }).verdict(task.id, "accept", "good");
  const io = captureIo();

  const code = await runVerdictCommand([task.id, "wrong", "-m", "actually no"], { recordHome, ...io });

  assert.equal(code, 1);
  assert.match(io.err[0], /already has a final verdict/);
});
