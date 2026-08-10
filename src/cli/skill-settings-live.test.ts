// Companion to skill-settings.test.ts: that file proves the allow/deny
// boundary by replicating the harness's documented Bash-pattern rules
// against a hand-written matcher. This file proves the same boundary
// against a real, non-interactive session of the harness itself -
// documentation can be stale or misread, so "the pipeline denies
// fabrica verdict/answer and runs fabrica do/status/log/watch" is
// checked against the real permission_denials the harness reports,
// not just against the rules on paper.
//
// This costs a real API call and briefly patches a real, machine-wide
// trust setting for a scratch directory (see
// skill/<harness>/permission-boundary-verify.ts for why and how it's
// undone), so it never runs by default - only with
// FABRICA_TEST_REAL_PERMISSIONS=1 set, matching this project's
// established pattern for tests that drive a real coding-agent binary
// (see the reference CLI adapter's own real-binary test under
// src/brain/adapters/). Skipping is loud, not silent: the after() hook
// below prints a banner naming why, so a run that never actually
// proved the boundary can't be mistaken for one that did.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const skillDir = join(repoRoot, "skill");

let skipReason: string | undefined;

after(() => {
  if (skipReason) {
    console.log(`\n[skill-settings-live] SKIPPED real-permission-boundary proof: ${skipReason}\n`);
  }
});

function harnessesWithLiveVerifier(): string[] {
  if (!existsSync(skillDir)) return [];
  return readdirSync(skillDir)
    .filter((name) => statSync(join(skillDir, name)).isDirectory())
    .filter((harness) => existsSync(join(skillDir, harness, "settings.json")))
    .filter((harness) => existsSync(join(skillDir, harness, "permission-boundary-verify.ts")));
}

test("real session: the shipped settings.json actually runs do/status/log/watch and actually denies verdict/answer, including a chained bypass attempt", async (t) => {
  if (process.env.FABRICA_TEST_REAL_PERMISSIONS !== "1") {
    skipReason = "FABRICA_TEST_REAL_PERMISSIONS=1 not set";
    return t.skip(skipReason);
  }

  const harnesses = harnessesWithLiveVerifier();
  if (harnesses.length === 0) {
    skipReason = "no harness ships both settings.json and permission-boundary-verify.ts";
    return t.skip(skipReason);
  }

  for (const harness of harnesses) {
    const { checkPermissionBoundary } = (await import(
      pathToFileURL(join(skillDir, harness, "permission-boundary-verify.ts")).href
    )) as {
      checkPermissionBoundary: (
        cwd: string,
        settingsJsonPath: string,
        attempts: string[]
      ) => Promise<{
        available: boolean;
        unavailableReason?: string;
        executedArgs: string[];
        deniedCommands: string[];
      }>;
    };

    const scratch = mkdtempSync(join(tmpdir(), "fabrica-live-permissions-"));
    try {
      const attempts = [
        "fabrica status",
        'fabrica do "a task"',
        "fabrica log task-1",
        "fabrica watch task-1",
        "fabrica verdict task-1 accept -m note",
        "fabrica answer task-1 -m answer-text",
        "fabrica status && fabrica verdict task-1 accept -m note",
      ];

      const result = await checkPermissionBoundary(scratch, join(skillDir, harness, "settings.json"), attempts);
      if (!result.available) {
        skipReason = `${harness}: ${result.unavailableReason}`;
        return t.skip(skipReason);
      }

      for (const freeArgs of ["status", "do a task", "log task-1", "watch task-1"]) {
        assert.ok(
          result.executedArgs.includes(freeArgs),
          `${harness}: "fabrica ${freeArgs}" never actually ran in a real session - executedArgs was ${JSON.stringify(result.executedArgs)}`
        );
      }

      for (const deniedArgs of ["verdict task-1 accept -m note", "answer task-1 -m answer-text"]) {
        assert.equal(
          result.executedArgs.includes(deniedArgs),
          false,
          `${harness}: "fabrica ${deniedArgs}" actually ran in a real session - it must be denied, not merely undocumented as allowed`
        );
      }
      assert.ok(
        result.deniedCommands.some((c) => c.includes("verdict")),
        `${harness}: no real permission_denials entry named the verdict attempt - deniedCommands was ${JSON.stringify(result.deniedCommands)}`
      );
      assert.ok(
        result.deniedCommands.some((c) => c.includes("answer")),
        `${harness}: no real permission_denials entry named the answer attempt - deniedCommands was ${JSON.stringify(result.deniedCommands)}`
      );

      assert.ok(
        result.deniedCommands.some((c) => c.includes("&&") && c.includes("verdict")),
        `${harness}: the chained "fabrica status && fabrica verdict ..." attempt was not denied as a whole - deniedCommands was ${JSON.stringify(result.deniedCommands)}`
      );
      assert.equal(
        result.executedArgs.includes("verdict task-1 accept -m note"),
        false,
        `${harness}: the verdict half of the chained attempt actually ran - a chained bypass got through`
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
});
