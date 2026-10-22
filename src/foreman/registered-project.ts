// "Which projects.toml entry, if any, is this project?" - shared by the
// parts of the loop that read a per-project setting out of the registry
// (network-policy.ts's hosts and relay limits, touched-tests.ts's
// only-touched-tests ruling). Lifted out of network-policy.ts, which
// owned the only copy, rather than written a third time.
//
// resolve-check.ts deliberately keeps its own, differently-behaved
// lookup: it refuses loudly on a malformed projects.toml, because it
// runs first in every round and is the right place for that error to
// surface. This one answers "undefined" for every ConfigError instead -
// a setting with a sane default must not be the thing that reports a
// broken registry.

import { realpathSync } from "node:fs";
import { ConfigError, loadConfig } from "../config/index.ts";
import type { ProjectConfig } from "../config/index.ts";

/**
 * The registered entry whose `path` is this same directory, or
 * undefined when there is no projects.toml, no entry matching it, or
 * the file cannot be parsed.
 *
 * Both sides of the comparison go through realpath, the given path
 * included: the loader only expands a leading `~`, and on macOS
 * tmpdir() sits behind a /var -> /private/var symlink, so otherwise the
 * same directory can look like two. Callers that already hold a
 * resolved path (`line.project`) lose nothing by it, and callers that
 * run before any ProductionLine exists (ask.ts) need it.
 */
export function registeredProject(recordHome: string, projectPath: string): ProjectConfig | undefined {
  let config;
  try {
    config = loadConfig(recordHome);
  } catch (err) {
    if (err instanceof ConfigError) return undefined;
    throw err;
  }
  const resolved = realpath(projectPath);
  return Object.values(config.projects).find((project) => realpath(project.path) === resolved);
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
