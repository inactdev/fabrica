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
}

export interface FabricaConfig {
  caps: Caps;
  projects: Record<string, ProjectConfig>;
}
