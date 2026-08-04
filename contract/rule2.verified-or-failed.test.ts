// CONTRACT rule 2 — "Done" means proven. No third option.
// A project whose own check fails must produce a failure report, never a
// delivery presented as done.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFabrica } from "./surface.ts";
import { fakeBrain } from "./helpers/fake-brain.ts";
import { makeFixtureRepo } from "./helpers/fixture.ts";

test("rule 2: a red check can only ever produce a failure report", async () => {
  const project = makeFixtureRepo("exit 1"); // this project's check ALWAYS fails

  const fabrica = createFabrica({ home: mkdtempSync(join(tmpdir(), "fabrica-home-")) });
  const task = await fabrica.do("any change at all", { project, brain: fakeBrain() });

  const delivery = await fabrica.deliveryOf(task.id);
  assert.ok(delivery, "no delivery record at all");
  assert.notEqual(delivery.kind, "done", "unverified work presented as done — rule 2 broken");
  assert.equal(delivery.kind, "failure-report");
});

test("rule 2: a green gate is recorded before anything is called done", async () => {
  const project = makeFixtureRepo("exit 0");

  const fabrica = createFabrica({ home: mkdtempSync(join(tmpdir(), "fabrica-home-")) });
  const task = await fabrica.do("any change at all", { project, brain: fakeBrain() });

  const receipts = await fabrica.receiptsOf(task.id);
  const delivered = receipts.find((r) => r.outcome === "delivered");
  if (delivered) {
    assert.ok(delivered.gate, "delivered with no gate result recorded");
    assert.equal(delivered.gate.green, true, "delivered on a non-green gate");
  }
});
