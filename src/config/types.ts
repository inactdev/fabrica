// The shapes of Fabrica's config: the project registry and the caps.
// LANGUAGE.md: "caps — dollar limits enforced by code at every step."

import type { Caps } from "../../contract/surface.ts";

// Rule 10's hard dollar limits: read from config here, enforced by the
// Foreman. The shape is the contract's own.
export type { Caps };

/** Who reviews a project's test changes: the model Inspector is handed
 * for that half of its run (`-vendor`/`-model`). Both fields are
 * required together — a vendor with no model, or a model with no
 * vendor, is not a reviewer Inspector could be given.
 *
 * The standing ruling: a reviewer must never be the Worker's own
 * vendor. That is enforced in code (src/reviewer/resolve.ts), not
 * left to whoever writes projects.toml. */
export interface ReviewerConfig {
  vendor: string;
  model: string;
}

/** One entry in projects.toml. `check` is optional at load time — a
 * project may be registered before its check command is decided — but
 * required before any task on it is allowed to proceed (rule 2). */
export interface ProjectConfig {
  /** As written in projects.toml, except a leading `~` the loader has
   * already expanded to the home directory. */
  path: string;
  check?: string;
  /** Extra hosts a Worker on this project may reach through the relay
   * (issue #186), e.g. `["registry.npmjs.org"]` for a project whose
   * check installs its own dependencies. **Additive**: the model host
   * and GitHub are always allowed, and these are added to them — a
   * project that declares none gets exactly those two (Client ruling,
   * issue #186). Each entry is a hostname, optionally `host:port`; a
   * leading `*.` matches one level of subdomain. Matching lives in
   * src/relay/allowlist.mjs, which is also where the syntax is
   * defined. */
  hosts?: string[];
  /** Overrides the relay's default limit on the size of a single
   * request a Worker may send through it (src/relay/limits.mjs's
   * DEFAULT_MAX_REQUEST_BYTES). */
  maxRequestBytes?: number;
  /** Overrides the relay's default limit on how many calls one task may
   * make through it (src/relay/limits.mjs's
   * DEFAULT_MAX_CALLS_PER_TASK). */
  maxCallsPerTask?: number;
  /** `[projects.<name>.reviewer]` — this project's own reviewer,
   * overriding the global `[reviewer]` table outright (not field by
   * field: a project that names one names both fields). */
  reviewer?: ReviewerConfig;
}

/** The pause rule (issue #189): how full the provider's own
 * subscription windows may get before Fabrica stops asking for more.
 * Unrelated to `Caps`, which is dollars - a flat-rate subscription's
 * windows cost nothing to fill and so no dollar cap can ever notice
 * them, which is the whole reason this exists next to them.
 *
 * Every field is a whole percentage, 0-100, and every field has a
 * default (see `DEFAULT_PAUSE_RULE`): unlike the dollar caps, which do
 * nothing until the Client sets one, the pause rule is always on. */
export interface PauseRule {
  /** Above this much of the 7-day window used, no new task, resumed
   * round or fix round starts. Default 70. */
  sevenDayRefusePercent: number;
  /** Above this much of the 7-day window used, an attempt already in
   * flight is stopped gracefully. Default 90. */
  sevenDayStopPercent: number;
  /** Above this much of the 5-hour window used, no new work starts.
   * There is deliberately no 5-hour stop threshold: that window refills
   * within hours, so stopping work already in flight for it would throw
   * away more than it saves (Client's clarification). Default 90. */
  fiveHourRefusePercent: number;
}

export interface FabricaConfig {
  caps: Caps;
  /** Always present - `[pause]` is optional in projects.toml, and its
   * absence means `DEFAULT_PAUSE_RULE`, not "no pause rule". */
  pause: PauseRule;
  projects: Record<string, ProjectConfig>;
  /** `[reviewer]` — the reviewer every project uses unless its own
   * entry overrides it. Absent means no reviewer is configured, which
   * only becomes a refusal for a project whose `.inspector.json`
   * declares `testPaths` (src/reviewer/resolve.ts). */
  reviewer?: ReviewerConfig;
}
