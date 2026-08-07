// Where this net remembers "what a registered project looked like last
// time anyone asked" — one small JSON file per project, readable with bare
// hands like everything else under the record home (SPEC.md "The record").
// This is scratch state for the net itself, not part of events.jsonl: the
// baseline can be deleted or corrupted without losing any history, since
// its only job is deciding whether the NEXT check should fire, and a
// missing baseline just means "treat this project as newly seen."

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectGitState } from "./types.ts";

function offBooksDir(recordHome: string): string {
  return join(recordHome, "offbooks");
}

/** Project names are TOML table keys, usually plain identifiers, but not
 * guaranteed path-safe — this is the one place that assumption gets
 * enforced, so a stray "/" in a name can't escape offBooksDir(). */
function safeFileName(projectName: string): string {
  return projectName.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function baselinePath(recordHome: string, projectName: string): string {
  return join(offBooksDir(recordHome), `${safeFileName(projectName)}.json`);
}

/** Null when this project has never been checked before. */
export function readBaseline(recordHome: string, projectName: string): ProjectGitState | null {
  try {
    const text = readFileSync(baselinePath(recordHome, projectName), "utf8");
    return JSON.parse(text) as ProjectGitState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null; // a corrupted baseline is treated as "never seen" — see detect.ts
  }
}

export function writeBaseline(recordHome: string, projectName: string, state: ProjectGitState): void {
  mkdirSync(offBooksDir(recordHome), { recursive: true });
  writeFileSync(baselinePath(recordHome, projectName), `${JSON.stringify(state, null, 2)}\n`);
}
