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

/** Spawns the real bootstrap against an entry script living under a
 * directory whose name contains `marker` (e.g. a literal '#' or '?'),
 * and asserts the entry actually ran. The fixture uses TypeScript-only
 * syntax (an `as Error` cast, matching run-task-entry.ts's own shape) on
 * purpose: plain JavaScript loads even at a transform target tsx derived
 * wrongly, so a JavaScript fixture would pass while every real
 * `fabrica do` from such a checkout died in tsx's transform. */
function assertBootstrapLoadsEntryAt(dirNameContaining: string): void {
  const base = mkdtempSync(join(tmpdir(), "fabrica-tsx-bootstrap-"));
  const entryDir = join(base, dirNameContaining);
  mkdirSync(entryDir);
  const markerPath = join(entryDir, "marker.txt");
  const entryPath = join(entryDir, "entry.ts");
  writeFileSync(
    entryPath,
    `import { writeFileSync } from "node:fs";\n` +
      `const outcome: unknown = "ran\\n";\n` +
      `try {\n` +
      `  writeFileSync(${JSON.stringify(markerPath)}, outcome as string);\n` +
      `} catch (err) {\n` +
      `  throw new Error((err as Error).message);\n` +
      `}\n`
  );

  execFileSync(process.execPath, [BOOTSTRAP, entryPath], { stdio: "pipe" });

  assert.equal(readFileSync(markerPath, "utf8"), "ran\n");
}

test("tsx-bootstrap.mjs: loads an entry script whose path contains '#'", () => {
  // import() parses a bare specifier as a URL, so a checkout living at a
  // path containing '#' (a real fleet condition - workers run out of
  // generated worktree paths) would truncate there under a raw import()
  // and every `fabrica do` would fail to start its detached child.
  assertBootstrapLoadsEntryAt("worktree#7-dirty");
});

test("tsx-bootstrap.mjs: refuses an entry script whose path contains '?', with a clear message", () => {
  // pathToFileURL fixes Node's own import()-as-URL truncation for '?'
  // too, but tsx's own TypeScript transform has a separate, unfixable-
  // from-here bug that only survives for '#' (README.md's "Why a
  // checkout path can never contain a literal '?'") - so '?' is refused
  // outright rather than attempted, regardless of what the entry script
  // actually contains.
  const base = mkdtempSync(join(tmpdir(), "fabrica-tsx-bootstrap-"));
  const entryDir = join(base, "worktree?7-dirty");
  mkdirSync(entryDir);
  const entryPath = join(entryDir, "entry.ts");
  writeFileSync(entryPath, `throw new Error("must not run");\n`);

  assert.throws(
    () => execFileSync(process.execPath, [BOOTSTRAP, entryPath], { stdio: "pipe" }),
    (err: unknown) => {
      const stderr = (err as { stderr: Buffer }).stderr.toString("utf8");
      assert.match(stderr, /checkout's path contains a "\?"/);
      assert.match(stderr, /tsx/);
      assert.doesNotMatch(stderr, /Transform failed/);
      return true;
    }
  );
});
