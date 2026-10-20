// The config a command runs under, for the commands that need caps or
// projects but must still work against a record home with no
// projects.toml yet.

import { ConfigError, DEFAULT_PAUSE_RULE, loadConfig } from "../index.ts";
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
    // No projects.toml means no caps and no projects - but the pause
    // rule (issue #189) still applies at its defaults, since it guards
    // the Client's subscription rather than a figure he configured.
    if (err instanceof ConfigError && err.code === "not-found") {
      return { caps: {}, pause: { ...DEFAULT_PAUSE_RULE }, projects: {} };
    }
    throw err;
  }
}
