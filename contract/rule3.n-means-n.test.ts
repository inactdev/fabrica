// CONTRACT rule 3 — Three means three.
// When the Client gives a count, exactly that many worker invocations
// happen. The count is a loop in code; the fake brain counts the calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFabrica } from "./surface.ts";
import { fakeBrain } from "./helpers/fake-brain.ts";
import { makeFixtureRepo } from "./helpers/fixture.ts";

for (const n of [1, 3, 5]) {
  test(`rule 3: asking for ${n} attempts causes exactly ${n} worker runs`, async () => {
    const project = makeFixtureRepo("exit 0");
    const brain = fakeBrain();

    const fabrica = createFabrica({ home: mkdtempSync(join(tmpdir(), "fabrica-home-")) });
    await fabrica.do("same task, counted attempts", { project, n, brain });

    assert.equal(brain.calls, n, `asked for ${n}, worker ran ${brain.calls} times — rule 3 broken`);
  });
}
