import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "./foreman.ts";
import { ForemanError } from "./errors.ts";
import { deliveryOf, receiptsOf } from "./queries.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-verdict-home-"));
}

test("accept closes the task and leaves the delivery untouched", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome });
  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain: fakeBrain() });

  await foreman.verdict(task.id, "accept", "looks right");

  const mine = (await foreman.status()).find((t) => t.id === task.id);
  assert.equal(mine?.state, "closed");
  assert.equal((await foreman.receiptsOf(task.id)).length, 1, "accept records no extra attempt");
});

test("wrong closes the task plainly, as a real outcome, not a hidden failure", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome });
  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain: fakeBrain() });

  await foreman.verdict(task.id, "wrong", "not what I asked for");

  const mine = (await foreman.status()).find((t) => t.id === task.id);
  assert.equal(mine?.state, "closed");
  const events = (await foreman.events(task.id)).map((e) => e.name);
  assert.deepEqual(events.filter((n) => n === "verdict-recorded"), ["verdict-recorded"]);
});

test("fix re-enters the same warm worker session on the same line", async () => {
  const recordHome = freshHome();
  const brain = fakeBrain();
  const foreman = createForeman({ recordHome });
  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain });

  assert.equal(brain.calls, 1);
  const firstReceipts = receiptsOf(recordHome, task.id);
  const firstSession = firstReceipts[0].session;
  assert.ok(firstSession);

  await foreman.verdict(task.id, "fix", "wrong button spot");

  assert.equal(brain.calls, 2, "fix ran exactly one more worker call");
  const sessions = [...brain.historyBySession.keys()];
  assert.deepEqual(sessions, [firstSession], "fix continued the same session, it did not start a new one");
  assert.deepEqual(brain.historyBySession.get(firstSession!), [
    "small change",
    `small change\n\n---\n\nThe Client reviewed your previous delivery and asked for a change. ` +
      `Keep everything that was already right, and fix exactly this:\n\nwrong button spot`,
  ]);

  const mine = (await foreman.status()).find((t) => t.id === task.id);
  assert.equal(mine?.state, "delivered", "a fix round leaves the task open, delivered again, not closed");

  const receipts = receiptsOf(recordHome, task.id);
  assert.equal(receipts.length, 2, "the fix round's receipt is appended to the original, not replacing it");
  assert.equal(receipts[1].attempt, 2, "attempt numbering continues instead of restarting at 1");

  const delivery = deliveryOf(recordHome, task.id);
  assert.equal(delivery?.outcome, "done");
});

test("fix is counted against the task's original attempt budget, and refuses once it's spent", async () => {
  const recordHome = freshHome();
  const brain = fakeBrain();
  const foreman = createForeman({ recordHome });
  // Default budget is 2 attempts; a green first attempt stops early
  // (1 used), leaving exactly 1 attempt for a single fix.
  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain });

  await foreman.verdict(task.id, "fix", "one more pass");
  assert.equal(brain.calls, 2, "budget of 2 allowed exactly one fix");

  await assert.rejects(
    () => foreman.verdict(task.id, "fix", "another pass, please"),
    (err: unknown) => err instanceof ForemanError && err.code === "attempts-exhausted"
  );
  assert.equal(brain.calls, 2, "the exhausted fix never touched the worker");
});

test("a verdict on an already-closed task refuses", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome });
  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain: fakeBrain() });
  await foreman.verdict(task.id, "accept", "good");

  await assert.rejects(
    () => foreman.verdict(task.id, "wrong", "actually no"),
    (err: unknown) => err instanceof ForemanError && err.code === "already-closed"
  );
});

test("a verdict before delivery refuses", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome });

  // No task-received or delivered event at all for this id.
  await assert.rejects(
    () => foreman.verdict("no-such-task", "accept"),
    (err: unknown) => err instanceof ForemanError && err.code === "unknown-task"
  );
});

test("fix without a note refuses, naming the note as what's missing", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome });
  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain: fakeBrain() });

  await assert.rejects(
    () => foreman.verdict(task.id, "fix"),
    (err: unknown) => err instanceof ForemanError && err.code === "missing-note"
  );
});

test("an unrecognized ruling refuses rather than silently doing nothing", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome });
  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain: fakeBrain() });

  const verdict = foreman.verdict as (taskId: string, ruling: string, note?: string) => Promise<void>;
  await assert.rejects(
    () => verdict(task.id, "maybe", "note"),
    (err: unknown) => err instanceof ForemanError && err.code === "invalid-verdict"
  );
});

test("a red do() run that already spent both default attempts leaves no budget for a fix", async () => {
  const recordHome = freshHome();
  const brain = fakeBrain();
  const foreman = createForeman({ recordHome });
  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 1"), brain });
  assert.equal(brain.calls, 2, "default policy: one attempt, one fix pass on red, both spent already");

  await assert.rejects(
    () => foreman.verdict(task.id, "fix", "try again"),
    (err: unknown) => err instanceof ForemanError && err.code === "attempts-exhausted"
  );
});
