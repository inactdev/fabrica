// Loads projects.toml: the project registry plus the global caps.
//
// The record home is always an input, never assumed (SPEC: "The record").
// Parallel workers must never share runtime state, so nothing here reads
// from a fixed `~/.fabrica` — only the outermost CLI layer picks that
// default, and it does so by passing it in like any other caller.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as TOML from "smol-toml";
import { ConfigError } from "./errors.ts";
import type { Caps, FabricaConfig, ProjectConfig } from "./types.ts";

export function projectsTomlPath(recordHome: string): string {
  return join(recordHome, "projects.toml");
}

export function loadConfig(recordHome: string): FabricaConfig {
  const path = projectsTomlPath(recordHome);

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(
        "not-found",
        `No projects.toml found at ${path}. Create one with a [caps] table ` +
          `and one [projects.<name>] table per registered project.`
      );
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = TOML.parse(text);
  } catch (err) {
    throw new ConfigError(
      "malformed",
      `${path} is not valid TOML: ${(err as Error).message}`
    );
  }

  if (!isTable(parsed)) {
    throw new ConfigError("malformed", `${path} must contain a TOML table at its root.`);
  }

  const { caps: rawCaps, projects: rawProjects, ...rest } = parsed;
  const extra = Object.keys(rest);
  if (extra.length > 0) {
    const staleTables = extra.filter((key) => isTable(rest[key]));
    const looseKeys = extra.filter((key) => !isTable(rest[key]));
    const sentences: string[] = [];
    if (staleTables.length > 0) {
      const named = staleTables.map((key) => `[${key}]`).join(", ");
      const moved = staleTables.map((key) => `[projects.${key}]`).join(", ");
      const one = staleTables.length === 1;
      sentences.push(
        `unknown top-level table(s): ${named}. If ${named} ${one ? "is" : "are"} ` +
          `a project from the old flat format, rename ${one ? "it" : "them"} to ${moved}.`
      );
    }
    if (looseKeys.length > 0) {
      sentences.push(`unknown top-level key(s): ${looseKeys.join(", ")}.`);
    }
    throw new ConfigError(
      "malformed",
      `${path}: ${sentences.join(" ")} Projects live under [projects.<name>] ` +
        `and globals under [caps].`
    );
  }

  const caps = parseCaps(rawCaps, path);
  const projects = parseProjects(rawProjects, path);

  return { caps, projects };
}

/**
 * A TOML table, as opposed to every other TOML value type. Arrays and
 * datetimes are `typeof "object"` too, so neither a bare `typeof` check nor
 * an `Array.isArray` guard alone tells a table from a value.
 */
function isTable(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

function parseProjects(value: unknown, path: string): Record<string, ProjectConfig> {
  const projects: Record<string, ProjectConfig> = Object.create(null);
  if (value === undefined) return projects;
  if (!isTable(value)) {
    throw new ConfigError("malformed", `${path}: [projects] must be a table.`);
  }
  for (const [name, entry] of Object.entries(value)) {
    projects[name] = parseProject(name, entry, path);
  }
  return projects;
}

function parseCaps(value: unknown, path: string): Caps {
  if (value === undefined) return {};
  if (!isTable(value)) {
    throw new ConfigError("malformed", `${path}: [caps] must be a table.`);
  }
  const { perTaskUsd, perDayUsd, ...rest } = value;
  const extra = Object.keys(rest);
  if (extra.length > 0) {
    throw new ConfigError(
      "malformed",
      `${path}: [caps] has unknown field(s): ${extra.join(", ")}. ` +
        `Only perTaskUsd and perDayUsd are recognized.`
    );
  }
  const caps: Caps = {};
  if (perTaskUsd !== undefined) {
    caps.perTaskUsd = requireCapUsd(perTaskUsd, `${path}: [caps].perTaskUsd`);
  }
  if (perDayUsd !== undefined) {
    caps.perDayUsd = requireCapUsd(perDayUsd, `${path}: [caps].perDayUsd`);
  }
  return caps;
}

function parseProject(name: string, value: unknown, path: string): ProjectConfig {
  if (!isTable(value)) {
    throw new ConfigError(
      "malformed",
      `${path}: [projects.${name}] must be a table with at least a "path" field.`
    );
  }
  const { path: projectPath, check, ...rest } = value;
  const extra = Object.keys(rest);
  if (extra.length > 0) {
    throw new ConfigError(
      "malformed",
      `${path}: [projects.${name}] has unknown field(s): ${extra.join(", ")}. ` +
        `Only path and check are recognized.`
    );
  }
  if (typeof projectPath !== "string" || projectPath.length === 0) {
    throw new ConfigError(
      "malformed",
      `${path}: [projects.${name}] is missing a "path" field (a string).`
    );
  }
  if (check !== undefined && typeof check !== "string") {
    throw new ConfigError("malformed", `${path}: [projects.${name}].check must be a string.`);
  }
  const resolvedPath = expandLeadingTilde(projectPath);
  return check === undefined ? { path: resolvedPath } : { path: resolvedPath, check };
}

/**
 * Expands a leading `~` to the OS home directory so a path written the way
 * SPEC.md prints it (`~/inkling-umbrella/spending-app`) works as-is.
 * Deliberately narrow: only a bare `~` or a `~/` prefix. `~user` is not
 * supported, and a `~` anywhere else is a literal character in a directory
 * name, so it is left alone.
 */
function expandLeadingTilde(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function requireCapUsd(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigError(
      "malformed",
      `${label} must be a finite number of dollars (for example 2.5).`
    );
  }
  if (value < 0) {
    throw new ConfigError(
      "malformed",
      `${label} must be zero or more dollars, not ${value}.`
    );
  }
  return value;
}
