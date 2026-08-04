// CONTRACT rule 7 — The rules police themselves.
// This is the watchdog (meta-test). It proves every contract rule has its
// named test file and that none of them has been deleted or hollowed out.
// It is the only test that should be GREEN in Phase 0: the answer key
// itself must be whole before the tool exists.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

test("rule 7: every contract rule has its named, non-hollow test", () => {
  const required = [
    "rule1.", "rule2.", "rule3.", "rule4.", "rule5.",
    "rule6.", "rule7.", "rule8.", "rule9.", "rule10.",
  ];
  const files = readdirSync(here).filter((f) => f.endsWith(".test.ts"));

  for (const prefix of required) {
    const file = files.find((f) => f.startsWith(prefix));
    assert.ok(file, `no test file for contract ${prefix.replace(".", "")} — watchdog bites`);

    const source = readFileSync(join(here, file), "utf8");
    assert.ok(source.includes("test("), `${file} contains no test() — hollowed out`);
    assert.match(source, /assert\./, `${file} contains no assertions — hollowed out`);
  }
});
