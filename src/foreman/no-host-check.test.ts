// Issue #64 (Client ruling 2026-10-08): Fabrica runs no project check on
// the host. The check command is a file the worker just edited; executing
// it outside a container hands the worker the Client's own machine. With
// Inspector, Inspector's containerized run is the gate; without it, the
// check runs once inside the worker's own box. This scans src/foreman for
// any way back to a host run, so one cannot be reintroduced quietly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const foremanDir = dirname(fileURLToPath(import.meta.url));

function productionFiles(): string[] {
  return readdirSync(foremanDir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
}

test("src/foreman/check.ts and its host runCheck are gone", () => {
  assert.equal(existsSync(join(foremanDir, "check.ts")), false, "check.ts still exists");
  for (const name of productionFiles()) {
    assert.doesNotMatch(readFileSync(join(foremanDir, name), "utf8"), /\brunCheck\b/, `${name} still names runCheck`);
  }
});

test("no file under src/foreman spawns a child process for anything but git", () => {
  for (const name of productionFiles()) {
    const source = readFileSync(join(foremanDir, name), "utf8");
    if (!/from "node:child_process"|require\("child_process"\)|from "child_process"/.test(source)) continue;
    const calls = [...source.matchAll(/\b(execSync|execFileSync|exec|execFile|spawn|spawnSync|fork)\s*\(\s*([^,)]*)/g)];
    assert.ok(calls.length > 0, `${name} imports child_process but no call was found to check - read it by hand`);
    for (const [, fn, firstArg] of calls) {
      assert.equal(
        firstArg.trim(),
        '"git"',
        `${name} calls ${fn}(${firstArg.trim()}, ...) - only git may be spawned from src/foreman, never a project's check`
      );
    }
  }
});
