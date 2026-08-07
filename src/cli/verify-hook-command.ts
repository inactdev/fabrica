// `fabrica verify-hook`: proves whether the session config installed in
// this directory actually blocks and logs an edit, instead of leaving
// that as something to assume (Client ruling on issue #13's
// hook-failure-fails-open finding - see the installed harness's own
// README under skill/). Runs a real, non-bypassed chat session here,
// right now, asking it to create a throwaway file, then reports plainly
// whether the edit was denied and whether the attempt was recorded.
//
// The actual spawn is harness-specific and lives under skill/<harness>/
// verify.ts - loaded here by scanning skill/ at runtime and importing
// whichever subfolder has one, rather than a hardcoded import path, so
// this file never has to name a harness (same rule as the rest of src/
// outside src/brain/adapters/ - contract/rule8.no-favorite-brain.test.ts
// scans for a harness's name as plain text, which a literal import
// specifier would be just as much as a comment).

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readEvents } from "../index.ts";
import { resolveRecordHome } from "./record-home.ts";

interface HarnessVerifier {
  attemptRealEdit(cwd: string, targetFileName: string): void;
  harnessAvailable(): boolean;
}

const SKILL_DIR = fileURLToPath(new URL("../../skill", import.meta.url));

/** The first skill/<harness>/verify.ts found - today there is exactly
 * one harness with a shipped config, so "first" and "only" coincide;
 * a second harness adding its own verify.ts would need this to pick
 * one deliberately instead of arbitrarily, not a problem yet. */
async function loadHarnessVerifier(): Promise<HarnessVerifier | null> {
  if (!existsSync(SKILL_DIR)) return null;
  for (const name of readdirSync(SKILL_DIR)) {
    const verifyPath = join(SKILL_DIR, name, "verify.ts");
    if (existsSync(verifyPath)) {
      return (await import(verifyPath)) as HarnessVerifier;
    }
  }
  return null;
}

export const VERIFY_HOOK_HELP = `Usage: fabrica verify-hook

Proves whether the session config installed in this directory is
actually working, instead of leaving that as something to assume: asks
your chat agent, right now, to create a throwaway file here with no
permission bypass, then reports whether the edit was denied and whether
the attempt was recorded on Fabrica's record.

Environment:
  FABRICA_HOME  Overrides the record home checked for the recorded attempt (default: ~/.fabrica).
`;

export interface RunVerifyHookOptions {
  cwd?: string;
  recordHome?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Test seam: bypasses the real harness discovery/spawn entirely. Both
   * must be given together, or neither is used. */
  attemptEdit?: (cwd: string, targetFileName: string) => void;
  harnessAvailable?: () => boolean;
}

/** Returns 0 only when the edit was both denied and recorded; 1 otherwise
 * (including when no harness verifier could be found or reached at all -
 * the printed message says which). */
export async function runVerifyHookCommand(opts: RunVerifyHookOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? ((line: string) => console.log(line));
  const stderr = opts.stderr ?? ((line: string) => console.error(line));

  let isHarnessAvailable = opts.harnessAvailable;
  let attempt = opts.attemptEdit;
  if (!isHarnessAvailable || !attempt) {
    const verifier = await loadHarnessVerifier();
    if (!verifier) {
      stderr("No per-harness verify script found under skill/ - nothing to run.");
      return 1;
    }
    isHarnessAvailable = isHarnessAvailable ?? verifier.harnessAvailable;
    attempt = attempt ?? verifier.attemptRealEdit;
  }

  if (!isHarnessAvailable()) {
    stderr("Could not find or run your chat agent - is it installed and on your PATH?");
    return 1;
  }

  const cwd = opts.cwd ?? process.cwd();
  const recordHome = opts.recordHome ?? resolveRecordHome();
  const targetFileName = `.fabrica-verify-hook-${randomUUID().slice(0, 8)}.tmp`;
  const targetPath = join(cwd, targetFileName);

  const eventsBefore = readEvents(recordHome).length;

  stdout("Attempting a real edit in this directory, through your installed session config...");
  attempt(cwd, targetFileName);

  const created = existsSync(targetPath);
  if (created) rmSync(targetPath, { force: true }); // never leave the throwaway file behind, pass or fail

  const newlyLogged = readEvents(recordHome)
    .slice(eventsBefore)
    .some((event) => event.name === "edit-attempt-blocked");

  const denied = !created;
  stdout(`  edit denied:    ${denied ? "yes" : "no - the file was actually created!"}`);
  stdout(`  attempt logged: ${newlyLogged ? "yes" : "no"}`);

  if (denied && newlyLogged) {
    stdout("Your session config is working correctly.");
    return 0;
  }
  stdout("Your session config is NOT fully working - see the install steps for your harness under skill/.");
  return 1;
}
