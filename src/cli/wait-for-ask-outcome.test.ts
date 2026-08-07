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

  const outcome = await waitForAskOutcome(recordHome, "t1", { timeoutMs: 1000, pollMs: 10 });

  assert.equal(outcome.status, "asking");
  assert.deepEqual(outcome.questions, ["What database?"]);
});

test("waitForAskOutcome: resolves 'proceeding' once work-started lands", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "work-started" });

  const outcome = await waitForAskOutcome(recordHome, "t1", { timeoutMs: 1000, pollMs: 10 });

  assert.deepEqual(outcome, { status: "proceeding", questions: [] });
});

test("waitForAskOutcome: waits for a later event to appear rather than deciding too early", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });

  const promise = waitForAskOutcome(recordHome, "t1", { timeoutMs: 2000, pollMs: 10 });
  await new Promise((r) => setTimeout(r, 50));
  appendEvent(recordHome, { taskId: "t1", name: "work-started" });

  const outcome = await promise;
  assert.equal(outcome.status, "proceeding");
});

test("waitForAskOutcome: falls back to 'proceeding' on timeout rather than hanging forever", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });

  const started = Date.now();
  const outcome = await waitForAskOutcome(recordHome, "t1", { timeoutMs: 100, pollMs: 10 });
  const elapsedMs = Date.now() - started;

  assert.deepEqual(outcome, { status: "proceeding", questions: [] });
  assert.ok(elapsedMs < 2000, `expected the timeout to bound the wait, took ${elapsedMs}ms`);
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

  const outcome = await waitForAskOutcome(recordHome, "t1", { timeoutMs: 1000, pollMs: 10 });

  assert.equal(outcome.status, "proceeding");
});
