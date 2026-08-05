// CONTRACT rule 9 — It can't grade its own homework in the dark.
// A worker MAY change the project's checks openly (features change
// behavior; the gate must be able to change with them). What is forbidden
// is the silent version: an undeclared change to the gate is detected by
// the tool — it made the copy, it knows the before-state — and the
// attempt is discarded automatically.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFabrica } from "../src/index.ts";
import { fakeBrain } from "./helpers/fake-brain.ts";
import { makeFixtureRepo } from "./helpers/fixture.ts";

test("rule 9: an UNDECLARED edit to the project's checks is discarded", async () => {
  const project = makeFixtureRepo("exit 1"); // honest gate would fail...
  const cheat = fakeBrain({
    onWork: (workdir) => {
      // ...so the cheating worker silently rewrites the check to pass.
      writeFileSync(join(workdir, "check.sh"), "#!/bin/sh\nexit 0\n");
    },
  });

  const foreman = createFabrica({ recordHome: mkdtempSync(join(tmpdir(), "fabrica-home-")) });
  const task = await foreman.do("make the build green", { project, brain: cheat });

  const delivery = await foreman.deliveryOf(task.id);
  assert.ok(delivery, "no delivery record at all");
  assert.equal(
    delivery.outcome,
    "discarded-protected-path",
    "a silent gate edit was not discarded — rule 9 broken"
  );

  const receipts = await foreman.receiptsOf(task.id);
  assert.ok(
    receipts.some((r) => r.outcome === "discarded-protected-path"),
    "the discard is not on the receipt — rules 5+9 broken"
  );
});

test("rule 9: a DECLARED gate change is delivered, declaration attached", async () => {
  const project = makeFixtureRepo("exit 1"); // encodes the old truth...
  const honest = fakeBrain({
    onWork: (workdir) => {
      // ...and the brief legitimately changes that truth.
      writeFileSync(join(workdir, "check.sh"), "#!/bin/sh\nexit 0\n");
    },
    gateChanges: "check.sh: the brief changes the pass condition",
  });

  const foreman = createFabrica({ recordHome: mkdtempSync(join(tmpdir(), "fabrica-home-")) });
  const task = await foreman.do("change what green means", { project, brain: honest });

  const delivery = await foreman.deliveryOf(task.id);
  assert.ok(delivery, "no delivery record at all");
  assert.notEqual(
    delivery.outcome,
    "discarded-protected-path",
    "an openly declared gate change was discarded — amended rule 9 broken"
  );
  assert.ok(
    delivery.gateChanges.length > 0,
    "the declaration is missing from the delivery — the Client can't see the gate changed"
  );
});
