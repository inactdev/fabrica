// CONTRACT rule 5 — It writes everything down.
// A full task leaves every lifecycle event in the record, in order, and
// the record is append-only: running more work never rewrites history.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFabrica } from "./surface.ts";
import type { FabricaEventName } from "./surface.ts";
import { fakeBrain } from "./helpers/fake-brain.ts";
import { makeFixtureRepo } from "./helpers/fixture.ts";

test("rule 5: every lifecycle step is on the record, in order", async () => {
  const project = makeFixtureRepo("exit 0");
  const fabrica = createFabrica({ recordHome: mkdtempSync(join(tmpdir(), "fabrica-home-")) });

  const task = await fabrica.do("small change", { project, brain: fakeBrain() });
  const events = (await fabrica.events(task.id)).map((e) => e.name);

  const expectedOrder: FabricaEventName[] = ["task-received", "work-started", "check-run", "delivered"];
  let cursor = -1;
  for (const step of expectedOrder) {
    const at = events.indexOf(step, cursor + 1);
    assert.ok(at > cursor, `event "${step}" missing or out of order — rule 5 broken (saw: ${events.join(", ")})`);
    cursor = at;
  }
});

test("rule 5: the record is append-only across tasks", async () => {
  const project = makeFixtureRepo("exit 0");
  const fabrica = createFabrica({ recordHome: mkdtempSync(join(tmpdir(), "fabrica-home-")) });

  await fabrica.do("first task", { project, brain: fakeBrain() });
  const firstSnapshot = readFileSync(fabrica.recordPath(), "utf8");

  await fabrica.do("second task", { project, brain: fakeBrain() });
  const secondSnapshot = readFileSync(fabrica.recordPath(), "utf8");

  assert.ok(
    secondSnapshot.startsWith(firstSnapshot),
    "earlier record lines changed after later work — rule 5 broken"
  );
});
