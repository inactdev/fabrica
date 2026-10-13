// bin.mjs is the installed `fabrica` command's real entry point - its
// "?" refusal has to run as a real, separate process (not an import),
// since the whole point is that it fires before anything has taught
// Node how to load main.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REAL_BIN = fileURLToPath(new URL("./bin.mjs", import.meta.url));

test("bin.mjs: resolves its own source relative to its installed location, never the current directory", () => {
  // The installed `fabrica` command must work from any directory, which
  // is every directory it's actually run from once installed (issue:
  // installable from zero) - a `cwd` with no `src/`, no `node_modules`,
  // and no relation to this checkout at all proves resolution never
  // depended on it: `import "tsx/esm"` and the `main.ts` import are both
  // resolved against `import.meta.url` (this file's own real location),
  // not `process.cwd()`. If that ever regressed back to a cwd-relative
  // resolution (e.g. a bare specifier import, see README.md's "Why
  // `bin.mjs` isn't a shebang'd `.ts` file"), this would fail with
  // ERR_MODULE_NOT_FOUND instead of printing the help text.
  const elsewhere = mkdtempSync(join(tmpdir(), "fabrica-bin-elsewhere-"));
  const out = execFileSync(process.execPath, [REAL_BIN, "--help"], { cwd: elsewhere, encoding: "utf8" });
  assert.match(out, /fabrica - hand in a task/);
});

test("bin.mjs: refuses to start from a checkout path containing '?', with a clear message", () => {
  // The refusal has to fire before main.ts is ever imported (real
  // TypeScript syntax tsx cannot transform at a '?' path - README.md's
  // "Why a checkout path can never contain a literal '?'"), so a copy
  // of bin.mjs on its own, with no main.ts or node_modules alongside
  // it, proves the check runs first rather than failing for some other
  // reason.
  const base = mkdtempSync(join(tmpdir(), "fabrica-bin-"));
  const checkoutDir = join(base, "worktree?7-dirty");
  mkdirSync(checkoutDir);
  const binPath = join(checkoutDir, "bin.mjs");
  copyFileSync(REAL_BIN, binPath);
  assert.match(readFileSync(binPath, "utf8"), /checkout's path contains a "\?"/, "bin.mjs must still have its refusal");

  assert.throws(
    () => execFileSync(process.execPath, [binPath], { stdio: "pipe" }),
    (err: unknown) => {
      const stderr = (err as { stderr: Buffer }).stderr.toString("utf8");
      assert.match(stderr, /checkout's path contains a "\?"/);
      assert.match(stderr, /tsx/);
      assert.doesNotMatch(stderr, /Transform failed/);
      assert.doesNotMatch(stderr, /Cannot find module/);
      return true;
    }
  );
});
