// CONTRACT rule 2 - "Done" means proven.
// Fabrica runs no check of its own on the host. With Inspector, its
// independent run is the gate; without it, the check runs once in the
// worker's own box. Either way, red can never come back as "done".

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "../src/index.ts";
import { fakeBrain } from "./helpers/fake-brain.ts";
import { fakeInspector } from "./helpers/fake-inspector.ts";
import { fakeCheckBox } from "./helpers/fake-check-box.ts";
import { makeFixtureRepo } from "./helpers/fixture.ts";

test("rule 2: a red Inspector result never yields done; the outcome is inspection-red", async () => {
  const project = makeFixtureRepo("exit 0");

  const foreman = createForeman({
    recordHome: mkdtempSync(join(tmpdir(), "fabrica-home-")),
    inspector: fakeInspector("red"),
  });
  const task = await foreman.do("any change at all", { project, brain: fakeBrain() });

  const delivery = await foreman.deliveryOf(task.id);
  assert.ok(delivery, "no delivery record at all");
  assert.notEqual(delivery.outcome, "done", "unverified work presented as done — rule 2 broken");
  assert.equal(delivery.outcome, "inspection-red");
});

test("rule 2: without Inspector, a red self-test in the worker's box never yields done", async () => {
  const project = makeFixtureRepo("exit 0", { inspector: false });

  const foreman = createForeman({
    recordHome: mkdtempSync(join(tmpdir(), "fabrica-home-")),
    checkBox: fakeCheckBox({ ran: true, exitCode: 1, output: "1 test failed" }).box,
  });
  const task = await foreman.do("any change at all", { project, brain: fakeBrain() });

  const delivery = await foreman.deliveryOf(task.id);
  assert.ok(delivery, "no delivery record at all");
  assert.notEqual(delivery.outcome, "done", "unverified work presented as done - rule 2 broken");
  assert.equal(delivery.outcome, "failure-report");
});

test("rule 2: a green gate is recorded before anything is called done", async () => {
  const project = makeFixtureRepo("exit 0");

  const foreman = createForeman({
    recordHome: mkdtempSync(join(tmpdir(), "fabrica-home-")),
    inspector: fakeInspector("green"),
  });
  const task = await foreman.do("any change at all", { project, brain: fakeBrain() });

  const receipts = await foreman.receiptsOf(task.id);
  const delivered = receipts.find((r) => r.outcome === "delivered");
  if (delivered) {
    assert.ok(delivered.checks, "delivered with no gate result recorded");
    assert.equal(delivered.checks.green, true, "delivered on a non-green gate");
  }
});
