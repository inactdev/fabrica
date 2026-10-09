// The config a command runs under, for the commands that need caps or
// projects but must still work against a record home with no
// projects.toml yet.

import { ConfigError, loadConfig } from "../index.ts";
import type { FabricaConfig } from "../index.ts";

/** A record home with no projects.toml yet has no registered projects
 * and no caps - not an error. do()'s own resolveCheckCommand treats a
 * missing file the same way (falls back to the check.sh convention);
 * this mirrors that instead of refusing a first `fabrica do` ever run
 * against a plain `--project <path>` before any project is registered. */
export function loadConfigOrDefault(recordHome: string): FabricaConfig {
  try {
    return loadConfig(recordHome);
  } catch (err) {
    if (err instanceof ConfigError && err.code === "not-found") return { caps: {}, projects: {} };
    throw err;
  }
}
