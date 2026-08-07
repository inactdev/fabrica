// The entry point every `fabrica` command calls (SPEC.md "Catching
// off-the-books work": "every time any tool command runs, the tool checks
// each registered project"). Deliberately the most defensive function in
// this module: it is a courtesy, not a gate, so nothing it does may ever
// throw, and one project's failure must not stop the others from being
// checked or stop the command that triggered it from running at all.

import { loadConfig } from "../config/index.ts";
import { detectUnattributedChange } from "./detect.ts";

export function checkForOffBooksChanges(recordHome: string): void {
  let projects: Record<string, { path: string }>;
  try {
    projects = loadConfig(recordHome).projects;
  } catch {
    // No projects.toml yet, or it's malformed: nothing registered to
    // check against. Either way, never block the command over it — see
    // module comment above.
    return;
  }

  for (const [name, project] of Object.entries(projects)) {
    try {
      detectUnattributedChange(recordHome, name, project.path);
    } catch {
      // Never let one project's detection failure stop the rest, or the
      // command that called this.
    }
  }
}
