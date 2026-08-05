// Throwaway record homes for config tests — never the real ~/.fabrica,
// exactly as contract/helpers/fixture.ts throws away repos.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Makes a fresh temp record home and writes projects.toml into it. */
export function makeTestHome(projectsToml: string): string {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-config-test-"));
  writeFileSync(join(recordHome, "projects.toml"), projectsToml);
  return recordHome;
}
