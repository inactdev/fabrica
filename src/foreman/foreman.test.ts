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
    ["task-received", "work-started", "check-run", "delivered"]
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
