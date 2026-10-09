// CONTRACT rule 10 — It cannot outspend you.
// Hard dollar limits are enforced by code: a task that would start beyond
// the daily cap is refused with the numbers shown, and every receipt
// carries the money field so spending is always on the record.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "../src/index.ts";
import { fakeBrain } from "./helpers/fake-brain.ts";
import { makeFixtureRepo } from "./helpers/fixture.ts";

test("rule 10: a task beyond the daily cap is refused, numbers shown", async () => {
  const project = makeFixtureRepo("exit 0");
  const foreman = createForeman({
    recordHome: mkdtempSync(join(tmpdir(), "fabrica-home-")),
    caps: { perDayUsd: 0 },
  });

  await assert.rejects(
    () => foreman.do("any task at all", { project, brain: fakeBrain() }),
    /cap|\$/i,
    "a task started past the daily cap — rule 10 broken"
  );
});

test("rule 10: every receipt carries the money field", async () => {
  const project = makeFixtureRepo("exit 0");
  const foreman = createForeman({ recordHome: mkdtempSync(join(tmpdir(), "fabrica-home-")) });

  const task = await foreman.do("small change", { project, brain: fakeBrain() });
  const receipts = await foreman.receiptsOf(task.id);

  assert.ok(receipts.length > 0, "no receipts at all");
  for (const r of receipts) {
    assert.ok(
      Object.hasOwn(r, "costUsd"),
      "a receipt is missing its money field — rule 10 broken"
    );
  }
});

// --- Issue #11: the rest of rule 10, written as negative tests first. ---
// Each one attempts the forbidden act (spending past a cap, or spending
// without a known cost) and must fail while nothing enforces it.

function home(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-home-"));
}

test("rule 10: a daily-cap refusal shows the cap and the spend, and lands on the record", async () => {
  const recordHome = home();
  const project = makeFixtureRepo("exit 0");
  await createForeman({ recordHome }).do("first task", { project, brain: fakeBrain({ costUsd: 6.5 }) });

  const foreman = createForeman({ recordHome, caps: { perDayUsd: 5 } });
  await assert.rejects(
    () => foreman.do("second task", { project, brain: fakeBrain({ costUsd: 1 }) }),
    (err: Error) => /\$5\.00/.test(err.message) && /\$6\.50/.test(err.message),
    "a daily-cap refusal must name both the cap ($5.00) and the spend so far ($6.50)"
  );

  const refused = (await foreman.status()).find((t) => t.state === "failed");
  assert.ok(refused, "the refused task is not on the record at all");
  const events = await foreman.events(refused.id);
  const capRefused = events.find((e) => e.name === "cap-refused");
  assert.ok(capRefused, "no cap-refused event on the refused task's record");
  assert.match(JSON.stringify(capRefused.details), /6\.5/);
});

test("rule 10: a task is hard-stopped when it crosses its per-task cap mid-run", async () => {
  const project = makeFixtureRepo("exit 1");
  const foreman = createForeman({ recordHome: home(), caps: { perTaskUsd: 5 } });
  const brain = fakeBrain({ costUsd: 3 });

  const task = await foreman.do("keeps failing, keeps spending", { project, brain, attempts: 4 });

  assert.equal(brain.calls, 2, "work continued past the per-task cap ($3 + $3 >= $5)");
  assert.equal(task.state, "failed");
  const delivery = await foreman.deliveryOf(task.id);
  assert.ok(delivery, "a cap stop must still deliver an honest report");
  assert.equal(delivery.outcome, "cap-stopped", "the report must say the cap stopped it, not that the work failed");
  assert.match(`${delivery.summary} ${delivery.gaps}`, /\$5\.00/);
  assert.match(`${delivery.summary} ${delivery.gaps}`, /\$6\.00/);

  const events = await foreman.events(task.id);
  assert.ok(events.some((e) => e.name === "cap-stopped"), "no cap-stopped event on the record");

  const receipts = await foreman.receiptsOf(task.id);
  assert.deepEqual(receipts.map((r) => r.costUsd), [3, 3]);
  assert.equal(receipts.at(-1)?.outcome, "cap-stopped");

  // The remaining per-task budget is handed to the brain as a hint.
  assert.deepEqual(brain.workOptions.map((o) => o?.maxSpendUsd), [5, 2]);
});

test("rule 10: spend of unknown cost does not count as zero against a cap", async () => {
  const recordHome = home();
  const project = makeFixtureRepo("exit 0");
  const foreman = createForeman({ recordHome, caps: { perDayUsd: 100 } });

  const unmeasured = await foreman.do("an unmeasured task", { project, brain: fakeBrain({ costUsd: null }) });
  const [receipt] = await foreman.receiptsOf(unmeasured.id);
  assert.equal(receipt.costUsd, null);
  assert.equal(receipt.costUnknown, true, "the unmeasured receipt carries no mark on the record");

  const brain = fakeBrain({ costUsd: 1 });
  await assert.rejects(
    () => foreman.do("a further task", { project, brain }),
    (err: Error) => err.message.includes("SPEND UNKNOWN - tasks blocked") && err.message.includes(unmeasured.id),
    "a further task proceeded as though the unmeasured spend were $0"
  );
  assert.equal(brain.calls, 0);
});

test("rule 10: a usage entry with null cost under a cap stops the task, SPEND UNKNOWN in the report", async () => {
  const project = makeFixtureRepo("exit 1");
  const foreman = createForeman({ recordHome: home(), caps: { perTaskUsd: 100 } });
  const brain = fakeBrain({ costUsd: null });

  const task = await foreman.do("spends an unknown amount", { project, brain, attempts: 3 });

  assert.equal(brain.calls, 1, "kept spending after the cost became unknown");
  const delivery = await foreman.deliveryOf(task.id);
  assert.equal(delivery?.outcome, "cap-stopped");
  assert.match(`${delivery?.summary} ${delivery?.gaps}`, /SPEND UNKNOWN - tasks blocked/);
});

test("rule 10: recording the cost by hand clears the block", async () => {
  const recordHome = home();
  const project = makeFixtureRepo("exit 0");
  const foreman = createForeman({ recordHome, caps: { perDayUsd: 100 } });
  const unmeasured = await foreman.do("an unmeasured task", { project, brain: fakeBrain({ costUsd: null }) });

  await assert.rejects(() => foreman.recordCost(unmeasured.id, Number.NaN), /cost/i);
  await assert.rejects(() => foreman.recordCost(unmeasured.id, -1), /cost/i);
  await assert.rejects(
    () => foreman.do("still blocked", { project, brain: fakeBrain({ costUsd: 1 }) }),
    /SPEND UNKNOWN/,
    "the block cleared without a cost actually being recorded"
  );

  await foreman.recordCost(unmeasured.id, 0.75);
  assert.ok((await foreman.events(unmeasured.id)).some((e) => e.name === "cost-recorded"));
  await assert.rejects(
    () => foreman.recordCost(unmeasured.id, 0.75),
    /nothing/i,
    "a second hand entry for already-recorded spend must be refused, not counted twice"
  );

  const next = await foreman.do("now it may start", { project, brain: fakeBrain({ costUsd: 1 }) });
  assert.equal(next.state, "delivered");
});

test("rule 10: the day's total survives a restart", async () => {
  const recordHome = home();
  const project = makeFixtureRepo("exit 0");
  await createForeman({ recordHome, caps: { perDayUsd: 5 } }).do("spends past the cap", {
    project,
    brain: fakeBrain({ costUsd: 6 }),
  });

  const fresh = createForeman({ recordHome, caps: { perDayUsd: 5 } });
  await assert.rejects(
    () => fresh.do("would exceed the cap given that history", { project, brain: fakeBrain({ costUsd: 1 }) }),
    /\$6\.00/,
    "a fresh Foreman forgot the day's spend - the total was only held in memory"
  );
});
