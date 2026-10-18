// The per-task network policy in force for a `brain.ask`/`brain.work`
// call in flight (issue #186, second half): which record a refused host
// is appended to, which hosts this project declared on top of the base
// ones, and the two limits the relay enforces.
//
// Deliberately NOT part of BrainWorkOptions/contract/surface.ts. `Brain`
// is CONTRACT rule 8's socket, ratified as brief/workdir/opts, and
// `ask(brief)` takes nothing else on purpose (rule 1 holds there by
// construction) - widening either would turn Fabrica's own plumbing into
// a promise every future adapter has to understand. An adapter that
// opens no network of its own never reads this at all.
//
// An AsyncLocalStorage rather than a module-level map keyed on `workdir`
// (src/brain/live-transcript.ts's own mechanism, the closest precedent
// here): `ask()` has no workdir to key on - it runs before any
// ProductionLine exists - and that call is a real model call over the
// real relay, so keying on workdir would leave the clarifying step
// outside the mechanism entirely. A scope also cannot leak past the call
// it wraps the way a registration missing its unregister can, while
// still keeping two tasks running concurrently in one process strictly
// apart, which is the property the workdir keying existed to protect.

import { AsyncLocalStorage } from "node:async_hooks";
import type { DeclaredNetwork } from "../relay/index.ts";

/** What a project declared in projects.toml (`DeclaredNetwork`: the
 * hosts, in its own spelling - `"example.com"`, `"example.com:8443"`,
 * `"*.example.com"` - plus the two relay limits), together with the
 * task those declarations are in force for. Extending that shape rather
 * than restating it means an adapter can hand the whole policy straight
 * to `tunnelAllowlistFor`/`relayLimitsFor` with nothing to translate
 * and no field name to keep in step by hand. `import type` only: this
 * module gains no runtime dependency on the relay. */
export interface TaskNetworkPolicy extends DeclaredNetwork {
  /** Where a refusal is appended - the Client's real record home, so a
   * refused host lands on `fabrica log <id>` (issue #186). */
  recordHome: string;
  taskId: string;
}

const storage = new AsyncLocalStorage<TaskNetworkPolicy>();

/** Runs `fn` with `policy` visible to `currentTaskNetwork()` for
 * everything it awaits, however deep - the Foreman wraps each
 * `brain.ask`/`brain.work` call with this. Returns whatever `fn`
 * returns. */
export function withTaskNetwork<T>(policy: TaskNetworkPolicy, fn: () => T): T {
  return storage.run(policy, fn);
}

/** The policy for the call currently in flight, or undefined when
 * nothing wrapped it - a library-level caller, or a test driving an
 * adapter directly. An adapter must still work in that case: it has no
 * task to attribute a refusal to, so it falls back to its own
 * throwaway record location and its base hosts alone. */
export function currentTaskNetwork(): TaskNetworkPolicy | undefined {
  return storage.getStore();
}
