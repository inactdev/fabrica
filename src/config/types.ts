// The shapes of Fabrica's config: the project registry and the caps.
// LANGUAGE.md: "caps — dollar limits enforced by code at every step."

/** Rule 10: hard dollar limits, read from config, enforced elsewhere. */
export interface Caps {
  perTaskUsd?: number;
  perDayUsd?: number;
}

/** One entry in projects.toml. `check` is optional at load time — a
 * project may be registered before its check command is decided — but
 * required before any task on it is allowed to proceed (rule 2). */
export interface ProjectConfig {
  path: string;
  check?: string;
}

export interface FabricaConfig {
  caps: Caps;
  projects: Record<string, ProjectConfig>;
}
