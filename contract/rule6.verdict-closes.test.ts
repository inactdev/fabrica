// CONTRACT rule 6 — You get the last word.
// A delivered task stays open and listed until the Client's verdict is
// recorded; the verdict is what closes the loop.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "./surface.ts";
import { fakeBrain } from "./helpers/fake-brain.ts";
import { makeFixtureRepo } from "./helpers/fixture.ts";

test("rule 6: a delivered task stays open until a verdict is recorded", async () => {
  const project = makeFixtureRepo("exit 0");
  const foreman = createForeman({ recordHome: mkdtempSync(join(tmpdir(), "fabrica-home-")) });

  const task = await foreman.do("small change", { project, brain: fakeBrain() });

  const openBefore = await foreman.status();
  assert.ok(
    openBefore.some((t) => t.id === task.id && t.state !== "closed"),
    "delivered task vanished from status before any verdict — rule 6 broken"
  );

  await foreman.verdict(task.id, "accept", "looks right");

  const openAfter = await foreman.status();
  const mine = openAfter.find((t) => t.id === task.id);
  assert.ok(!mine || mine.state === "closed", "verdict recorded but task still open");
});

test("rule 6: the verdict lands on the record", async () => {
  const project = makeFixtureRepo("exit 0");
  const foreman = createForeman({ recordHome: mkdtempSync(join(tmpdir(), "fabrica-home-")) });

  const task = await foreman.do("small change", { project, brain: fakeBrain() });
  await foreman.verdict(task.id, "fix", "right direction, wrong button spot");

  const events = (await foreman.events(task.id)).map((e) => e.name);
  assert.ok(events.includes("verdict-recorded"), "verdict not on the record — rules 5+6 broken");
});
