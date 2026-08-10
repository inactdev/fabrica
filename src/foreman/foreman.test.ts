import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "./foreman.ts";
import { ForemanError } from "./errors.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-foreman-fabrica-home-"));
}

test("createForeman().recordPath() points at events.jsonl under the given record home", () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome });
  assert.equal(foreman.recordPath(), join(recordHome, "events.jsonl"));
});

test("status() lists a delivered task as delivered, not closed, before any verdict", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome });
  const project = makeFixtureRepo("exit 0");

  const task = await foreman.do("small change", { project, brain: fakeBrain() });

  const tasks = await foreman.status();
  const mine = tasks.find((t) => t.id === task.id);
  assert.ok(mine);
  assert.equal(mine.state, "delivered");
});

test("status() lists a failed task as failed", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome });
  const project = makeFixtureRepo("exit 1");

  const task = await foreman.do("small change", { project, brain: fakeBrain() });

  const tasks = await foreman.status();
  const mine = tasks.find((t) => t.id === task.id);
  assert.ok(mine);
  assert.equal(mine.state, "failed");
});

test("verdict() on an unknown task id refuses plainly", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome });

  await assert.rejects(
    () => foreman.verdict("some-task-id", "accept"),
    (err: unknown) => err instanceof ForemanError && err.code === "unknown-task"
  );
});

test("events() returns this task's events only, in order", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome });
  const project = makeFixtureRepo("exit 0");

  const taskA = await foreman.do("task a", { project, brain: fakeBrain() });
  const taskB = await foreman.do("task b", { project, brain: fakeBrain() });

  const eventsA = await foreman.events(taskA.id);
  assert.ok(eventsA.every((e) => e.taskId === taskA.id));
  assert.deepEqual(
    eventsA.map((e) => e.name),
    // "check-run" lands twice per attempt: once when the check starts
    // (details.phase === "started", issue #12) and once with its result.
    ["task-received", "line-cut", "work-started", "check-run", "check-run", "delivered"]
  );

  const eventsB = await foreman.events(taskB.id);
  assert.ok(eventsB.every((e) => e.taskId === taskB.id));
});

test("deliveryOf() and receiptsOf() return null/empty for an unknown task id", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome });

  assert.equal(await foreman.deliveryOf("no-such-task"), null);
  assert.deepEqual(await foreman.receiptsOf("no-such-task"), []);
});

test("status() lists an asking task as asking, and answer() moves it on", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome });
  const project = makeFixtureRepo("exit 0");

  const asked = await foreman.do("build me an app", {
    project,
    brain: fakeBrain({ askQuestions: ["Which database?"] }),
  });
  assert.equal(asked.state, "asking");

  const beforeAnswer = (await foreman.status()).find((t) => t.id === asked.id);
  assert.equal(beforeAnswer?.state, "asking");

  const resumed = await foreman.answer(asked.id, "Postgres.");
  assert.equal(resumed.state, "delivered");

  const afterAnswer = (await foreman.status()).find((t) => t.id === asked.id);
  assert.equal(afterAnswer?.state, "delivered");
});

// Mirrors verdict()'s own same-instance brain memory: a do() call that
// ended up "asking" already recorded its brain by taskId, so answer()
// on the SAME Foreman instance reuses it without a brain argument of
// its own (contract/surface.ts's Foreman.answer takes none).
test("answer() reuses the exact brain a same-instance do() call was given", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome });
  const project = makeFixtureRepo("exit 0");
  const brain = fakeBrain({ askQuestions: ["Which?"] });

  const asked = await foreman.do("build me an app", { project, brain });
  await foreman.answer(asked.id, "An answer.");

  assert.equal(brain.calls, 1, "the same brain instance was reused for the resumed round");
});

test("answer() on an unknown task id refuses plainly", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome });

  await assert.rejects(
    () => foreman.answer("some-task-id", "an answer"),
    (err: unknown) => err instanceof ForemanError && err.code === "unknown-task"
  );
});

// Client ruling, issue #8 follow-up: a task whose brain.ask() itself
// threw must show up as failed, not silently stuck at "working" forever
// (stateOf's own fallback) or missing from status() entirely.
test("status() lists a task whose ask() threw as failed", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome });
  const project = makeFixtureRepo("exit 0");
  const brain = fakeBrain({ askError: new Error("simulated: the brain is unreachable") });

  await assert.rejects(() => foreman.do("build me an app", { project, brain }));

  const tasks = await foreman.status();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].state, "failed");
});
