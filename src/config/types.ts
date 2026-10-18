// The shapes of Fabrica's config: the project registry and the caps.
// LANGUAGE.md: "caps — dollar limits enforced by code at every step."

import type { Caps } from "../../contract/surface.ts";

// Rule 10's hard dollar limits: read from config here, enforced by the
// Foreman. The shape is the contract's own.
export type { Caps };

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
}

export interface FabricaConfig {
  caps: Caps;
  projects: Record<string, ProjectConfig>;
}
