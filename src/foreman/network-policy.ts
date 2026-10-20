// What a task's worker box is allowed to reach, read out of
// projects.toml (issue #186, second half) - the second place src/config
// participates in the loop, alongside resolve-check.ts, and matched
// against the project exactly the way that file does.
//
// The Foreman wraps each brain.ask/brain.work call in the policy this
// returns (src/brain/task-network.ts); the adapter composing a relay
// for that call reads it there. Nothing about it is threaded through
// `Brain` or `contract/surface.ts` - see that module's own header.

import { registeredProject } from "./registered-project.ts";
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
 * The lookup itself is registered-project.ts's (shared with
 * touched-tests.ts); a malformed projects.toml reads as "no
 * declaration" here rather than throwing, because resolve-check.ts runs
 * first in every round and refuses on it, loudly, where that error
 * belongs.
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
