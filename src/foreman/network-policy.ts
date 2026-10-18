// What a task's worker box is allowed to reach, read out of
// projects.toml (issue #186, second half) - the second place src/config
// participates in the loop, alongside resolve-check.ts, and matched
// against the project exactly the way that file does.
//
// The Foreman wraps each brain.ask/brain.work call in the policy this
// returns (src/brain/task-network.ts); the adapter composing a relay
// for that call reads it there. Nothing about it is threaded through
// `Brain` or `contract/surface.ts` - see that module's own header.

import { realpathSync } from "node:fs";
import { ConfigError, loadConfig } from "../config/index.ts";
import type { ProjectConfig } from "../config/index.ts";
import type { TaskNetworkPolicy } from "../brain/index.ts";

/**
 * The policy for one task: the hosts and limits its project declared,
 * or no declaration at all when the project isn't registered (or there
 * is no projects.toml). "No declaration" is not "nothing allowed" - the
 * adapter's own base hosts (the model provider and GitHub) always
 * apply, and src/relay/limits.mjs's defaults hold - so an unregistered
 * project, which is what every contract fixture is, behaves exactly as
 * it did before any of this existed.
 *
 * Both sides of the comparison go through realpath, the project's own
 * path included: the loader only expands a leading `~`, and on macOS
 * tmpdir() sits behind a /var -> /private/var symlink, so otherwise the
 * same directory can look like two. (resolve-check.ts resolves only the
 * registered side because its own caller always hands it
 * `line.project`, already resolved; this one is also called from
 * ask.ts, before any ProductionLine exists to resolve anything.)
 */
export function networkPolicyFor(recordHome: string, taskId: string, projectPath: string): TaskNetworkPolicy {
  const registered = registeredProject(recordHome, projectPath);
  return {
    recordHome,
    taskId,
    hosts: registered?.hosts ?? [],
    ...(registered?.maxRequestBytes !== undefined ? { maxRequestBytes: registered.maxRequestBytes } : {}),
    ...(registered?.maxCallsPerTask !== undefined ? { maxCallsPerTask: registered.maxCallsPerTask } : {}),
  };
}

function registeredProject(recordHome: string, projectPath: string): ProjectConfig | undefined {
  let config;
  try {
    config = loadConfig(recordHome);
  } catch (err) {
    // A missing projects.toml is the ordinary unregistered case. Any
    // other config error (malformed TOML) is left to the callers that
    // already report it properly - resolve-check.ts runs first in every
    // round and refuses there, loudly, rather than here.
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
