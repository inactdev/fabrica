// CONTRACT rule 8 — No favorite brain.
// The whole lifecycle must run with a completely fake brain plugged into
// the adapter socket, and no brain-specific code may exist outside the
// adapter directory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createForeman } from "../src/index.ts";
import { fakeBrain } from "./helpers/fake-brain.ts";
import { makeFixtureRepo } from "./helpers/fixture.ts";

test("rule 8: the whole lifecycle runs on a completely fake brain", async () => {
  const project = makeFixtureRepo("exit 0");
  const brain = fakeBrain();

  const foreman = createForeman({ recordHome: mkdtempSync(join(tmpdir(), "fabrica-home-")) });
  const task = await foreman.do("small change", { project, brain });

  assert.ok(brain.calls >= 1, "the plugged-in brain was never used");
  assert.ok(await foreman.deliveryOf(task.id), "no delivery from a fake-brained run");
});

test("rule 8: no brain-specific code outside the adapter directory", () => {
  // Vacuously true until src/ exists (Phase 1); then it bites for real.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const srcDir = join(root, "src");
  const brainWords = /claude|anthropic|openai|gpt-|gemini|codex|grok/i;
  const offenders: string[] = [];

  const scan = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === "adapters") continue; // the one room where brains are known
        scan(p);
      } else if (brainWords.test(readFileSync(p, "utf8"))) {
        offenders.push(p.slice(root.length + 1));
      }
    }
  };

  if (existsSync(srcDir)) scan(srcDir);
  assert.deepEqual(offenders, [], `brain-specific code outside adapters: ${offenders.join(", ")}`);
});
