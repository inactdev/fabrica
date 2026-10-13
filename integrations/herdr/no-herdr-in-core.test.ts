// Negative test (issue #125): Fabrica's core never names Herdr - this
// integration reaches into src/ (via src/index.ts's generic exports) but
// nothing in src/ reaches back or even mentions it, the same way rule 8
// keeps every brain's name confined to src/brain/adapters/
// (contract/rule8.no-favorite-brain.test.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

test("nothing under src/ mentions Herdr", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const srcDir = join(root, "src");
  const herdrWord = /herdr/i;
  const offenders: string[] = [];

  const scan = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        scan(p);
      } else if (herdrWord.test(readFileSync(p, "utf8"))) {
        offenders.push(p.slice(root.length + 1));
      }
    }
  };

  assert.ok(existsSync(srcDir), "src/ should exist");
  scan(srcDir);
  assert.deepEqual(offenders, [], `Herdr mentioned under src/: ${offenders.join(", ")}`);
});
