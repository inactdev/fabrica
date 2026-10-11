import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent } from "../record/index.ts";
import { waitForAskOutcome } from "./wait-for-ask-outcome.ts";

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-wait-ask-"));
}

test("waitForAskOutcome: resolves 'asking' with the questions once questions-asked lands", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, {
    taskId: "t1",
    name: "questions-asked",
    details: { questions: ["What database?"], project: "/p", totalAttempts: 2, explicitAttempts: false },
  });

  const outcome = await waitForAskOutcome(recordHome, "t1", { pollMs: 10 });

  assert.equal(outcome.status, "asking");
  assert.deepEqual(outcome.questions, ["What database?"]);
});

test("waitForAskOutcome: resolves 'proceeding' once work-started lands", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "work-started" });

  const outcome = await waitForAskOutcome(recordHome, "t1", { pollMs: 10 });

  assert.deepEqual(outcome, { status: "proceeding", questions: [] });
});

test("waitForAskOutcome: waits for a later event to appear rather than deciding too early", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });

  const promise = waitForAskOutcome(recordHome, "t1", { pollMs: 10 });
  await new Promise((r) => setTimeout(r, 50));
  appendEvent(recordHome, { taskId: "t1", name: "work-started" });

  const outcome = await promise;
  assert.equal(outcome.status, "proceeding");
});

// Client ruling 2026-10-10 (#73): no fixed cutoff. A slow clarifying
// step is waited out, saying so on a fixed interval, instead of being
// reported as "proceeding" after 60s - which is how a task that never
// started used to look like one that did.
test("waitForAskOutcome: has no fixed cutoff - it keeps waiting, saying so every notice interval, until an outcome lands", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  const notices: string[] = [];

  const promise = waitForAskOutcome(recordHome, "t1", {
    pollMs: 5,
    noticeMs: 30,
    onStillWaiting: (line) => notices.push(line),
  });
  await new Promise((r) => setTimeout(r, 200));
  appendEvent(recordHome, { taskId: "t1", name: "work-started" });

  assert.equal((await promise).status, "proceeding");
  assert.ok(notices.length >= 3, `expected several notices across the wait, got ${notices.length}`);
  assert.ok(notices.every((n) => n === "still waiting on the clarifying step"));
});

test("waitForAskOutcome: resolves 'failed' with the message once task-failed lands", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "task-failed", details: { message: "no check.sh in the project" } });

  const outcome = await waitForAskOutcome(recordHome, "t1", { pollMs: 10 });

  assert.deepEqual(outcome, { status: "failed", questions: [], reason: "no check.sh in the project" });
});

test("waitForAskOutcome: a task process that ended without recording an outcome is a failure, not a wait forever", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });

  const outcome = await waitForAskOutcome(recordHome, "t1", { pollMs: 10, isAlive: () => false });

  assert.equal(outcome.status, "failed");
  assert.match(outcome.reason ?? "", /ended without recording an outcome/);
  assert.match(outcome.reason ?? "", /cli\.log/);
});

// Client ruling, issue #8 follow-up: a brain that throws must be
// detected directly, not left to exhaust the timeout and get reported
// as "proceeding" (a false success).
test("waitForAskOutcome: resolves 'failed' with the reason once ask-failed lands, well before any timeout", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "ask-failed", details: { error: "the brain is unreachable" } });

  const started = Date.now();
  // A generous timeout the "failed" detection must resolve well inside -
  // proves this is a real, immediate signal, not the timeout in disguise.
  const outcome = await waitForAskOutcome(recordHome, "t1", { pollMs: 10 });
  const elapsedMs = Date.now() - started;

  assert.deepEqual(outcome, { status: "failed", questions: [], reason: "the brain is unreachable" });
  assert.ok(elapsedMs < 1000, `expected ask-failed to resolve immediately, took ${elapsedMs}ms`);
});

test("waitForAskOutcome: only looks at the given task's own events", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, {
    taskId: "other-task",
    name: "questions-asked",
    details: { questions: ["Not mine"], project: "/p", totalAttempts: 2, explicitAttempts: false },
  });
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "work-started" });

  const outcome = await waitForAskOutcome(recordHome, "t1", { pollMs: 10 });

  assert.equal(outcome.status, "proceeding");
});
