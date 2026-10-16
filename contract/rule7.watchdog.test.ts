// CONTRACT rule 7 — The rules police themselves.
// This is the watchdog (meta-test). It proves every contract rule — read
// straight out of CONTRACT.md, not a hand-typed list — has its named test
// file, and that none of them has been deleted or hollowed out. Reading
// the rule count from CONTRACT.md (rather than keeping a list here) is
// the point: a rule 12 added to the contract with no test must fail this
// test without anyone having to remember to update the watchdog too.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// The rules themselves are numbered headings like "**7. The rules police
// themselves.**" in CONTRACT.md. That numbering is the one source of
// truth for how many rules exist.
function ruleNumbers() {
  const source = readFileSync(join(root, "CONTRACT.md"), "utf8");
  const numbers = [];
  for (const m of source.matchAll(/^\*\*(\d+)\./gm)) {
    numbers.push(Number(m[1]));
  }
  assert.ok(numbers.length > 0, "found no numbered rules in CONTRACT.md — watchdog can't read its own answer key");
  return numbers;
}

// Every name a contract test could legitimately reference: everything
// src/index.ts exports, plus every event name contract/surface.ts's
// FabricaEventName union declares. Built from the code, not hand-kept,
// so a new export or event is covered the moment it exists.
function knownFabricaNames(): Set<string> {
  const names = new Set<string>();

  const indexSource = readFileSync(join(root, "src/index.ts"), "utf8");
  for (const m of indexSource.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const rawPart of m[1].split(",")) {
      const part = rawPart.trim();
      if (!part) continue;
      const asMatch = part.match(/^\S+\s+as\s+(\S+)$/);
      names.add(asMatch ? asMatch[1] : part);
    }
  }

  const surfaceSource = readFileSync(join(root, "contract/surface.ts"), "utf8");
  const unionStart = surfaceSource.indexOf("export type FabricaEventName");
  assert.ok(unionStart !== -1, "contract/surface.ts no longer declares FabricaEventName — watchdog can't read event names");
  const unionEnd = surfaceSource.indexOf(";", unionStart);
  const unionBlock = surfaceSource.slice(unionStart, unionEnd === -1 ? surfaceSource.length : unionEnd);
  // Only the `| "name"` union members — not quoted strings that happen to
  // sit inside this block's own doc comments (e.g. an example value).
  for (const m of unionBlock.matchAll(/^\s*\|\s*"([^"]+)"/gm)) {
    names.add(m[1]);
  }

  assert.ok(names.size > 0, "found no exported names or event names — watchdog's own name list is empty");
  return names;
}

// The file's own logic, with the `import ...` lines stripped out. A
// hollowed test that still imports a Fabrica name it no longer calls
// would otherwise read as "referencing" that name when it no longer
// does — so only text outside the import block counts.
function nonImportSource(source: string) {
  return source
    .split("\n")
    .filter((line: string) => !/^\s*import\b/.test(line))
    .join("\n");
}

test("rule 7: every contract rule in CONTRACT.md has its named, non-hollow test", () => {
  const knownNames = knownFabricaNames();
  const files = readdirSync(here).filter((f) => f.endsWith(".test.ts"));

  for (const n of ruleNumbers()) {
    const prefix = `rule${n}.`;
    const file = files.find((f) => f.startsWith(prefix));
    assert.ok(file, `no test file for contract rule ${n} — watchdog bites`);

    const source = readFileSync(join(here, file), "utf8");
    assert.ok(source.includes("test("), `${file} contains no test() — hollowed out`);
    assert.match(source, /assert\./, `${file} contains no assertions — hollowed out`);

    const body = nonImportSource(source);
    const referencesRealName = [...knownNames].some((name) => body.includes(name));
    assert.ok(
      referencesRealName,
      `${file} has no assertion referencing a real Fabrica function or event — hollowed out`,
    );
  }
});
