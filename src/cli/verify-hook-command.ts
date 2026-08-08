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
import type { FabricaEvent } from "../index.ts";
import { resolveRecordHome } from "./record-home.ts";

export interface HarnessVerifier {
  attemptRealEdit(cwd: string, targetFileName: string): void;
  harnessAvailable(): boolean;
}

const SKILL_DIR = fileURLToPath(new URL("../../skill", import.meta.url));

function isHarnessVerifier(module: unknown): module is HarnessVerifier {
  const candidate = module as Partial<HarnessVerifier> | null;
  return typeof candidate?.attemptRealEdit === "function" && typeof candidate?.harnessAvailable === "function";
}

export interface HarnessVerifierLookup {
  verifier: HarnessVerifier | null;
  /** A verify.ts that is right there on disk but could not be loaded - it
   * threw at module scope, or imports something that no longer resolves.
   * Kept separate from "nothing found" so the caller can say which it was:
   * telling the Client no verify script exists, when one does, sends him
   * looking for a file he is already staring at. */
  loadFailures: { path: string; error: string }[];
}

/** The first skill/<harness>/verify.ts that actually exports both halves -
 * today there is exactly one harness with a shipped config, so "first" and
 * "only" coincide; a second harness adding its own verify.ts would need this
 * to pick one deliberately instead of arbitrarily, not a problem yet. A
 * half-written verify.ts is skipped rather than returned, so the caller
 * reports it as "nothing to run" instead of dying on a TypeError. */
export async function loadHarnessVerifier(skillDir: string = SKILL_DIR): Promise<HarnessVerifierLookup> {
  const loadFailures: { path: string; error: string }[] = [];
  if (!existsSync(skillDir)) return { verifier: null, loadFailures };
  for (const name of readdirSync(skillDir)) {
    const verifyPath = join(skillDir, name, "verify.ts");
    if (!existsSync(verifyPath)) continue;
    let module: unknown = null;
    try {
      module = await import(verifyPath);
    } catch (err) {
      loadFailures.push({ path: verifyPath, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (isHarnessVerifier(module)) return { verifier: module, loadFailures };
  }
  return { verifier: null, loadFailures };
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
  /** Test seam: bypasses the real harness discovery/spawn entirely. One
   * object, not two callbacks, so half a seam - a fake edit paired with
   * the real availability probe against the installed binary - can't be
   * supplied by accident. */
  harness?: HarnessVerifier;
  /** Test seam: the directory scanned for `<harness>/verify.ts`, so the real
   * discovery-and-import path itself is exercisable, not only bypassed. */
  skillDir?: string;
}

/** Whether an `edit-attempt-blocked` event is *this* attempt's. The
 * throwaway file name carries a random slice, and the hook payload puts
 * the blocked call's file path (or shell command) on `details.target`, so
 * this is what separates the attempt just made here from one an unrelated
 * session appended to the same shared record while this command ran. */
function isAttemptOn(event: FabricaEvent, targetFileName: string): boolean {
  if (event.name !== "edit-attempt-blocked") return false;
  const target = (event.details as { target?: unknown } | undefined)?.target;
  return typeof target === "string" && target.includes(targetFileName);
}

/** Returns 0 only when the edit was both denied and recorded; 1 otherwise
 * (including when no harness verifier could be found or reached at all -
 * the printed message says which). */
export async function runVerifyHookCommand(opts: RunVerifyHookOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? ((line: string) => console.log(line));
  const stderr = opts.stderr ?? ((line: string) => console.error(line));

  let verifier = opts.harness ?? null;
  if (!verifier) {
    const found = await loadHarnessVerifier(opts.skillDir);
    verifier = found.verifier;
    for (const failure of found.loadFailures) {
      stderr(`${failure.path} could not be loaded: ${failure.error}`);
    }
  }
  if (!verifier) {
    stderr("No usable per-harness verify script found under skill/ - nothing to run.");
    return 1;
  }

  if (!verifier.harnessAvailable()) {
    stderr("Could not find or run your chat agent - is it installed and on your PATH?");
    return 1;
  }

  const cwd = opts.cwd ?? process.cwd();
  const recordHome = opts.recordHome ?? resolveRecordHome();
  const targetFileName = `.fabrica-verify-hook-${randomUUID().slice(0, 8)}.tmp`;
  const targetPath = join(cwd, targetFileName);

  const eventsBefore = readEvents(recordHome).length;

  stdout("Attempting a real edit in this directory, through your installed session config...");
  verifier.attemptRealEdit(cwd, targetFileName);

  const created = existsSync(targetPath);
  if (created) rmSync(targetPath, { force: true }); // never leave the throwaway file behind, pass or fail

  const newlyLogged = readEvents(recordHome)
    .slice(eventsBefore)
    .some((event) => isAttemptOn(event, targetFileName));

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
