// CONTRACT rule 10 — It cannot outspend you.
// Hard dollar limits are enforced by code: a task that would start beyond
// the daily cap is refused with the numbers shown, and every receipt
// carries the money field so spending is always on the record.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "./surface.ts";
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
