// The clarifying step's cost lands on the record (Client ruling
// 2026-10-10): a number when the brain reports one, unknown when it
// reports null or reports nothing - never folded in as zero.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "./foreman.ts";
import { taskSpend, unmeasuredSpend } from "./spend.ts";
import { fakeInspector } from "../../contract/helpers/fake-inspector.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { readEvents } from "../record/index.ts";
import type { Brain, BrainAskResult } from "../brain/index.ts";

function brainAsking(result: BrainAskResult): Brain {
  return {
    name: "asker",
    model: "a-1",
    async ask() {
      return result;
    },
    async work() {
      return { transcript: [{ occurredAt: "", kind: "usage", text: JSON.stringify({ totalCostUsd: 0 }) }] };
    },
  };
}

async function runOnce(result: BrainAskResult) {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-ask-cost-"));
  const task = await createForeman({ recordHome, inspector: fakeInspector("green") }).do("small change", {
    project: makeFixtureRepo("exit 0"),
    brain: brainAsking(result),
  });
  return { events: readEvents(recordHome), taskId: task.id };
}

test("a reported clarifying-step cost is recorded and counted in the task's spend", async () => {
  const { events, taskId } = await runOnce({ costUsd: 0.25 });
  assert.ok(events.some((e) => e.name === "ask-cost-recorded"), "the clarifying step's cost is not on the record");
  assert.equal(taskSpend(events, taskId).knownUsd, 0.25);
  assert.deepEqual(unmeasuredSpend(events), []);
});

test("a null clarifying-step cost is recorded as unknown, not zero", async () => {
  const { events, taskId } = await runOnce({ costUsd: null });
  assert.deepEqual(unmeasuredSpend(events), [{ taskId, attempts: [0] }]);
});

test("a brain that reports no clarifying-step cost at all is unknown too", async () => {
  const { events, taskId } = await runOnce({});
  assert.deepEqual(unmeasuredSpend(events), [{ taskId, attempts: [0] }]);
});
