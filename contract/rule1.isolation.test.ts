// CONTRACT rule 1 — It never touches your stuff.
// Runs a task against a fixture repo and proves the Client's checkout is
// byte-for-byte identical afterward. Work must happen on a throwaway copy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "./surface.ts";
import { fakeBrain } from "./helpers/fake-brain.ts";
import { makeFixtureRepo, fingerprint } from "./helpers/fixture.ts";

test("rule 1: the Client's checkout is untouched, byte for byte", async () => {
  const project = makeFixtureRepo("exit 0");
  const before = fingerprint(project);

  const fabrica = createForeman({ recordHome: mkdtempSync(join(tmpdir(), "fabrica-home-")) });
  await fabrica.do("append one line to app.txt", { project, brain: fakeBrain() });

  const after = fingerprint(project);
  assert.equal(after, before, "original checkout changed — rule 1 broken");
});
