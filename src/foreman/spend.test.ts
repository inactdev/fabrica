import { test } from "node:test";
import assert from "node:assert/strict";
import type { FabricaEvent, Receipt, TranscriptEntry } from "../../contract/surface.ts";
import { costFromTranscript, daySpend, DAY_WINDOW_MS, taskSpend, unmeasuredSpend } from "./spend.ts";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");

function receipt(
  task: string,
  attempt: number,
  startedAt: number,
  costUsd: number | null,
  costBasis: "metered" | "subscription-estimate" = "metered"
): Receipt {
  return {
    task,
    attempt,
    brain: "fake",
    model: "fake-1",
    startedAt: new Date(startedAt).toISOString(),
    durationMs: 1,
    costUsd,
    costUnknown: costUsd === null,
    costBasis,
    session: null,
    reasoningEffort: null,
    checks: null,
    outcome: "delivered",
  };
}

function recorded(r: Receipt): FabricaEvent {
  return { occurredAt: r.startedAt, taskId: r.task, name: "receipt-recorded", details: { receipt: r } };
}

function usage(totalCostUsd: unknown, costBasis?: "metered" | "subscription-estimate"): TranscriptEntry {
  return { occurredAt: "", kind: "usage", text: JSON.stringify({ totalCostUsd, ...(costBasis ? { costBasis } : {}) }) };
}

test("costFromTranscript: sums every usage entry", () => {
  assert.deepEqual(costFromTranscript([usage(0.25), { occurredAt: "", kind: "text", text: "hi" }, usage(0.5)]), {
    costUsd: 0.75,
    costBasis: "metered",
  });
});

test("costFromTranscript: one null usage entry makes the whole attempt unknown, never zero", () => {
  assert.equal(costFromTranscript([usage(0.25), usage(null)]).costUsd, null);
});

test("costFromTranscript: no usage entry at all is unknown, not zero", () => {
  assert.equal(costFromTranscript([{ occurredAt: "", kind: "text", text: "hi" }]).costUsd, null);
});

test("costFromTranscript: an unparseable or non-numeric usage entry is unknown", () => {
  assert.equal(costFromTranscript([{ occurredAt: "", kind: "usage", text: "not json" }]).costUsd, null);
  assert.equal(costFromTranscript([usage("0.25")]).costUsd, null);
  assert.equal(costFromTranscript([usage(-1)]).costUsd, null);
});

test("costFromTranscript: an entry omitting costBasis defaults to metered", () => {
  assert.equal(costFromTranscript([usage(0.25)]).costBasis, "metered");
});

test("costFromTranscript: a subscription-estimate entry is reported as such (issue #188)", () => {
  assert.deepEqual(costFromTranscript([usage(0.25, "subscription-estimate")]), {
    costUsd: 0.25,
    costBasis: "subscription-estimate",
  });
});

test("daySpend: a rolling 24 hours ending now, not a calendar day", () => {
  const events = [
    recorded(receipt("a", 1, NOW - DAY_WINDOW_MS - 60_000, 100)),
    recorded(receipt("b", 1, NOW - DAY_WINDOW_MS + 60_000, 2)),
    recorded(receipt("c", 1, NOW - 60_000, 3)),
  ];
  assert.equal(daySpend(events, NOW).meteredUsd, 5);
});

test("daySpend: an attempt recorded twice (its own event and the delivery's receipts) counts once", () => {
  const r = receipt("a", 1, NOW - 1_000, 2);
  const events: FabricaEvent[] = [
    recorded(r),
    { occurredAt: r.startedAt, taskId: "a", name: "delivered", details: { receipts: [r] } },
  ];
  assert.equal(daySpend(events, NOW).meteredUsd, 2);
});

test("daySpend: receipts that only ever landed on a delivery (records from before issue #11) still count", () => {
  const r = receipt("a", 1, NOW - 1_000, 2);
  const events: FabricaEvent[] = [{ occurredAt: r.startedAt, taskId: "a", name: "delivered", details: { receipts: [r] } }];
  assert.equal(daySpend(events, NOW).meteredUsd, 2);
});

test("daySpend: a subscription-estimate receipt counts separately from metered spend (issue #188)", () => {
  const events = [
    recorded(receipt("a", 1, NOW - 1_000, 10, "metered")),
    recorded(receipt("b", 1, NOW - 1_000, 100, "subscription-estimate")),
  ];
  assert.deepEqual(daySpend(events, NOW), { meteredUsd: 10, subscriptionUsd: 100 });
});

test("taskSpend: a subscription-estimate receipt counts separately from metered spend (issue #188)", () => {
  const events = [recorded(receipt("t", 1, NOW, 10, "metered")), recorded(receipt("t", 2, NOW, 100, "subscription-estimate"))];
  assert.deepEqual(taskSpend(events, "t"), { meteredUsd: 10, subscriptionUsd: 100, unknownAttempts: [] });
});

test("unmeasuredSpend: an unknown cost blocks no matter how old it is, until recorded by hand", () => {
  const events = [recorded(receipt("old", 1, NOW - 10 * DAY_WINDOW_MS, null))];
  assert.deepEqual(unmeasuredSpend(events), [{ taskId: "old", attempts: [1] }]);

  events.push({ occurredAt: "", taskId: "old", name: "cost-recorded", details: { usd: 1.5, attempts: [1] } });
  assert.deepEqual(unmeasuredSpend(events), []);
});

test("unmeasuredSpend: a hand entry covers only the attempts it named, not later ones", () => {
  const events: FabricaEvent[] = [
    recorded(receipt("t", 1, NOW - 5_000, null)),
    { occurredAt: "", taskId: "t", name: "cost-recorded", details: { usd: 1, attempts: [1] } },
    recorded(receipt("t", 2, NOW - 1_000, null)),
  ];
  assert.deepEqual(unmeasuredSpend(events), [{ taskId: "t", attempts: [2] }]);
});

test("daySpend and taskSpend: a hand-recorded cost counts like a measured one", () => {
  const events: FabricaEvent[] = [
    recorded(receipt("t", 1, NOW - 5_000, null)),
    recorded(receipt("t", 2, NOW - 1_000, 0.5)),
    { occurredAt: "", taskId: "t", name: "cost-recorded", details: { usd: 1.25, attempts: [1] } },
  ];
  assert.equal(daySpend(events, NOW).meteredUsd, 1.75);
  assert.deepEqual(taskSpend(events, "t"), { meteredUsd: 1.75, subscriptionUsd: 0, unknownAttempts: [] });
});

test("taskSpend: reports unknown attempts instead of folding them into the total", () => {
  const events = [recorded(receipt("t", 1, NOW, 1)), recorded(receipt("t", 2, NOW, null))];
  assert.deepEqual(taskSpend(events, "t"), { meteredUsd: 1, subscriptionUsd: 0, unknownAttempts: [2] });
});
