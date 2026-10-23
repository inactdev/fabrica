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
  /** `model = "<name>"` — which model this project's Workers ask for
   * (issue #184), in whatever vocabulary the selected brain speaks (an
   * alias or a full model id). Omitted means the brain's own
   * configuration decides, which is the default. `fabrica do --model`
   * overrides it for one task; either way the choice and where it came
   * from land on every receipt (src/foreman/model.ts). */
  model?: string;
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
  /** `[projects.<name>.knowledge]` — the knowledge-base notes every
   * brief on this project carries, in full. Absent means none. */
  knowledge?: KnowledgeConfig;
  /** The Client's standing ruling (issue #142): a Worker on this project
   * runs only the tests covering what it touched, never the whole suite,
   * since the project's own check runs in full afterwards either way.
   * **Not optional** — the loader fills it in as `true` for every entry
   * that doesn't mention it, so an existing projects.toml written before
   * this existed carries the ruling too; `onlyTouchedTests = false` in
   * the entry is the way to turn it off for one project. A single task
   * opts out by saying so in its own text (src/foreman/touched-tests.ts).
   */
  onlyTouchedTests: boolean;
}

/** `[projects.<name>.knowledge]` — the knowledge base this project's
 * briefs draw on, and which of its notes every Worker on the project is
 * handed. Both fields are required together: a path naming no notes
 * puts nothing in a brief, and a list of notes with no path has nowhere
 * to read them from.
 *
 * Nothing is fetched: the notes are read off the local disk, as they
 * are, every time a brief is built (src/knowledge/). */
export interface KnowledgeConfig {
  /** The knowledge base repository's own root, holding a `notes/`
   * folder. Absolute by the time the loader is done with it: written
   * relative, it is resolved against the directory `projects.toml`
   * itself sits in, and a leading `~` is expanded like a project's own
   * path. */
  path: string;
  /** Bare note names — `"worker-boxes"` for `<path>/notes/worker-boxes.md`.
   * Flat only: a name carrying a path separator, or its own `.md`, is
   * refused by the loader rather than quietly looked for in the wrong
   * place. May be empty, which means this project adds no notes to a
   * brief. */
  notes: string[];
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
