// CONTRACT rule 3 — Three means three.
// When the Client gives a count, exactly that many worker invocations
// happen. The count is a loop in code; the fake brain counts the calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "./surface.ts";
import { fakeBrain } from "./helpers/fake-brain.ts";
import { makeFixtureRepo } from "./helpers/fixture.ts";

for (const attempts of [1, 3, 5]) {
  test(`rule 3: asking for ${attempts} attempts causes exactly ${attempts} worker runs`, async () => {
    const project = makeFixtureRepo("exit 0");
    const brain = fakeBrain();

    const fabrica = createForeman({ recordHome: mkdtempSync(join(tmpdir(), "fabrica-home-")) });
    await fabrica.do("same task, counted attempts", { project, attempts, brain });

    assert.equal(brain.calls, attempts, `asked for ${attempts}, worker ran ${brain.calls} times — rule 3 broken`);
  });
}
