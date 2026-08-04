// Refuses tasks for unregistered projects or missing check commands
// (CONTRACT rule 2: "No check command, no verified work, no exceptions").
// Every refusal names the project and says exactly what to add.

import { ConfigError } from "./errors.ts";
import type { FabricaConfig, ProjectConfig } from "./types.ts";

/** A ProjectConfig whose `check` is confirmed present. */
export interface CheckedProjectConfig extends ProjectConfig {
  check: string;
}

/**
 * Looks up `name` in the registry and confirms it has a check command.
 * Throws ConfigError("unregistered-project" | "missing-check") with a
 * message ready to show the Client verbatim.
 */
export function requireProject(config: FabricaConfig, name: string): CheckedProjectConfig {
  const project = Object.hasOwn(config.projects, name) ? config.projects[name] : undefined;
  if (!project) {
    throw new ConfigError(
      "unregistered-project",
      `Project "${name}" is not registered. Add it to projects.toml:\n\n` +
        `  [projects.${name}]\n` +
        `  path = "/path/to/${name}"\n` +
        `  check = "<the one command that must pass>"\n`
    );
  }

  if (!project.check || project.check.trim().length === 0) {
    throw new ConfigError(
      "missing-check",
      `Project "${name}" has no check command. No check command, no ` +
        `verified work, no exceptions. Add one to projects.toml:\n\n` +
        `  [projects.${name}]\n` +
        `  check = "<the one command that must pass>"\n`
    );
  }

  return project as CheckedProjectConfig;
}
