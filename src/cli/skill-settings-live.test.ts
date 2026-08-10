// Companion to skill-settings.test.ts: that file proves the allow/deny
// boundary by replicating the harness's documented Bash-pattern rules
// against a hand-written matcher. This file proves the same boundary
// against a real, non-interactive session of the harness itself -
// documentation can be stale or misread, so "the pipeline denies
// fabrica verdict/answer and runs fabrica do/status/log/watch" is
// checked against the real permission_denials the harness reports,
// not just against the rules on paper.
//
// A pass here only means something if it's actually caused by the
// shipped template - a session that inherited a permissive setting
// from the machine running the check (or from nothing at all) could
// make the free-command assertions pass for a reason that has
// nothing to do with what ships in skill/<harness>/settings.json,
// which would prove nothing about the boundary this whole file exists
// to check. permission-boundary-verify.ts isolates the session to
// just the project-level settings under test (`--setting-sources
// project`) for exactly this reason, and the two negative-control
// tests below exist to prove that isolation actually works: with no
// settings.json installed at all, and separately with the shipped
// template's own allow list emptied, the same free commands that pass
// in the positive test must NOT run. A check that passes with the
// template and would also pass without it is not testing the
// template.
//
// This costs a real API call per test and briefly patches a real,
// machine-wide trust setting for a scratch directory (see
// skill/<harness>/permission-boundary-verify.ts for why and how it's
// undone), so none of this runs by default - only with
// FABRICA_TEST_REAL_PERMISSIONS=1 set, matching this project's
// established pattern for tests that drive a real coding-agent binary
// (see the reference CLI adapter's own real-binary test under
// src/brain/adapters/). Skipping is loud, not silent: the after() hook
// below prints a banner naming why, so a run that never actually
// proved the boundary can't be mistaken for one that did.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const skillDir = join(repoRoot, "skill");

const FREE_ATTEMPTS = ["fabrica status", 'fabrica do "a task"', "fabrica log task-1", "fabrica watch task-1"];
const FREE_ARGS = ["status", "do a task", "log task-1", "watch task-1"];

interface CheckResult {
  available: boolean;
  unavailableReason?: string;
  executedArgs: string[];
  deniedCommands: string[];
}

type CheckPermissionBoundary = (cwd: string, settingsJsonPath: string | null, attempts: string[]) => Promise<CheckResult>;

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

async function loadChecker(harness: string): Promise<CheckPermissionBoundary> {
  const module = (await import(pathToFileURL(join(skillDir, harness, "permission-boundary-verify.ts")).href)) as {
    checkPermissionBoundary: CheckPermissionBoundary;
  };
  return module.checkPermissionBoundary;
}

/** An allow-emptied copy of the shipped template, written to a fresh
 * scratch file - same deny/hooks, permissions.allow: []. */
function emptyAllowVariant(harness: string, scratchParent: string): string {
  const shipped = JSON.parse(readFileSync(join(skillDir, harness, "settings.json"), "utf8"));
  shipped.permissions.allow = [];
  const dir = mkdtempSync(join(scratchParent, "empty-allow-"));
  const variantPath = join(dir, "settings.json");
  writeFileSync(variantPath, JSON.stringify(shipped, null, 2));
  return variantPath;
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
    const checkPermissionBoundary = await loadChecker(harness);
    const scratch = mkdtempSync(join(tmpdir(), "fabrica-live-permissions-"));
    try {
      const attempts = [
        ...FREE_ATTEMPTS,
        "fabrica verdict task-1 accept -m note",
        "fabrica answer task-1 -m answer-text",
        "fabrica status && fabrica verdict task-1 accept -m note",
      ];

      const result = await checkPermissionBoundary(scratch, join(skillDir, harness, "settings.json"), attempts);
      if (!result.available) {
        skipReason = `${harness}: ${result.unavailableReason}`;
        return t.skip(skipReason);
      }

      for (const freeArgs of FREE_ARGS) {
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
      // Exact matches against the specific attempt strings, not a
      // substring check - "verdict" appears in both the standalone
      // and the chained attempt, so a substring match could be
      // satisfied by the chained denial alone and pass vacuously for
      // the standalone case even if the model never attempted it.
      assert.ok(
        result.deniedCommands.includes("fabrica verdict task-1 accept -m note"),
        `${harness}: no real permission_denials entry named the standalone verdict attempt exactly - deniedCommands was ${JSON.stringify(result.deniedCommands)}`
      );
      assert.ok(
        result.deniedCommands.includes("fabrica answer task-1 -m answer-text"),
        `${harness}: no real permission_denials entry named the standalone answer attempt exactly - deniedCommands was ${JSON.stringify(result.deniedCommands)}`
      );
      assert.ok(
        result.deniedCommands.includes("fabrica status && fabrica verdict task-1 accept -m note"),
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

test("negative control: with no settings.json installed, none of the free commands run", async (t) => {
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
    const checkPermissionBoundary = await loadChecker(harness);
    const scratch = mkdtempSync(join(tmpdir(), "fabrica-live-permissions-noconfig-"));
    try {
      const result = await checkPermissionBoundary(scratch, null, FREE_ATTEMPTS);
      if (!result.available) {
        skipReason = `${harness}: ${result.unavailableReason}`;
        return t.skip(skipReason);
      }

      assert.deepEqual(
        result.executedArgs,
        [],
        `${harness}: a free command ran with NO settings.json installed at all (executedArgs was ` +
          `${JSON.stringify(result.executedArgs)}) - the positive test's passing result would not actually be ` +
          `caused by the shipped template if this can happen`
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
});

test("negative control: with the shipped template's own allow list emptied, none of the free commands run", async (t) => {
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
    const checkPermissionBoundary = await loadChecker(harness);
    const scratch = mkdtempSync(join(tmpdir(), "fabrica-live-permissions-emptyallow-"));
    const variantParent = mkdtempSync(join(tmpdir(), "fabrica-live-permissions-variant-"));
    try {
      const variantPath = emptyAllowVariant(harness, variantParent);
      const result = await checkPermissionBoundary(scratch, variantPath, FREE_ATTEMPTS);
      if (!result.available) {
        skipReason = `${harness}: ${result.unavailableReason}`;
        return t.skip(skipReason);
      }

      assert.deepEqual(
        result.executedArgs,
        [],
        `${harness}: a free command ran with the shipped template's permissions.allow emptied (executedArgs was ` +
          `${JSON.stringify(result.executedArgs)}) - the positive test's passing result would not actually be ` +
          `caused by the template's own allow entries if this can happen`
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(variantParent, { recursive: true, force: true });
    }
  }
});
