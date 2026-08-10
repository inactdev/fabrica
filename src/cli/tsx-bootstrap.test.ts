// tsx-bootstrap.mjs is what spawn-detached.ts's child process actually
// runs (see that file's comment); it must be exercised as a real,
// separate process rather than imported, since its whole job is being
// the command line a fresh `node` process is spawned with.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BOOTSTRAP = fileURLToPath(new URL("./tsx-bootstrap.mjs", import.meta.url));

test("tsx-bootstrap.mjs: loads an entry script whose path contains '#'", () => {
  // import() parses a bare specifier as a URL, so a checkout living at a
  // path containing '#' (a real fleet condition - workers run out of
  // generated worktree paths) would truncate there under a raw import()
  // and every `fabrica do` would fail to start its detached child.
  const base = mkdtempSync(join(tmpdir(), "fabrica-tsx-bootstrap-"));
  const entryDir = join(base, "worktree#7-dirty");
  mkdirSync(entryDir);
  const markerPath = join(entryDir, "marker.txt");
  const entryPath = join(entryDir, "entry.ts");
  writeFileSync(
    entryPath,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(markerPath)}, "ran\\n");\n`
  );

  execFileSync(process.execPath, [BOOTSTRAP, entryPath], { stdio: "pipe" });

  assert.equal(readFileSync(markerPath, "utf8"), "ran\n");
});
