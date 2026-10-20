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
import type { Caps, FabricaConfig, PauseRule, ProjectConfig } from "./types.ts";

/** Issue #189's defaults, as the Client gave them: "defaults 70 and 90
 * percent of the week". The 5-hour window refuses at 90 too, and never
 * stops work in flight - see `PauseRule`. */
export const DEFAULT_PAUSE_RULE: PauseRule = {
  sevenDayRefusePercent: 70,
  sevenDayStopPercent: 90,
  fiveHourRefusePercent: 90,
};

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

  const { caps: rawCaps, pause: rawPause, projects: rawProjects, ...rest } = parsed;
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
        `and globals under [caps] and [pause].`
    );
  }

  const caps = parseCaps(rawCaps, path);
  const pause = parsePause(rawPause, path);
  const projects = parseProjects(rawProjects, path);

  return { caps, pause, projects };
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

/** `[pause]` (issue #189). Absent means the defaults, not "off"; a
 * table that sets only some of the three keeps the defaults for the
 * rest. A stop threshold below its own refuse threshold is refused
 * outright rather than quietly accepted: it would mean "stop work
 * already in flight before you would even refuse to start it", which
 * can only be a mistake, and the pause rule is not a thing to have
 * guess what was meant. */
function parsePause(value: unknown, path: string): PauseRule {
  if (value === undefined) return { ...DEFAULT_PAUSE_RULE };
  if (!isTable(value)) {
    throw new ConfigError("malformed", `${path}: [pause] must be a table.`);
  }
  const { sevenDayRefusePercent, sevenDayStopPercent, fiveHourRefusePercent, ...rest } = value;
  const extra = Object.keys(rest);
  if (extra.length > 0) {
    throw new ConfigError(
      "malformed",
      `${path}: [pause] has unknown field(s): ${extra.join(", ")}. ` +
        `Only sevenDayRefusePercent, sevenDayStopPercent and fiveHourRefusePercent are recognized.`
    );
  }
  const pause: PauseRule = { ...DEFAULT_PAUSE_RULE };
  if (sevenDayRefusePercent !== undefined) {
    pause.sevenDayRefusePercent = requirePercent(sevenDayRefusePercent, `${path}: [pause].sevenDayRefusePercent`);
  }
  if (sevenDayStopPercent !== undefined) {
    pause.sevenDayStopPercent = requirePercent(sevenDayStopPercent, `${path}: [pause].sevenDayStopPercent`);
  }
  if (fiveHourRefusePercent !== undefined) {
    pause.fiveHourRefusePercent = requirePercent(fiveHourRefusePercent, `${path}: [pause].fiveHourRefusePercent`);
  }
  if (pause.sevenDayStopPercent < pause.sevenDayRefusePercent) {
    throw new ConfigError(
      "malformed",
      `${path}: [pause].sevenDayStopPercent (${pause.sevenDayStopPercent}) is below ` +
        `[pause].sevenDayRefusePercent (${pause.sevenDayRefusePercent}), which would stop work already running ` +
        `before it would even refuse to start any. Raise the stop threshold, or lower the refuse one.`
    );
  }
  return pause;
}

function requirePercent(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new ConfigError(
      "malformed",
      `${label} must be a percentage from 0 to 100, not ${String(value)}.`
    );
  }
  return value;
}

function parseProject(name: string, value: unknown, path: string): ProjectConfig {
  if (!isTable(value)) {
    throw new ConfigError(
      "malformed",
      `${path}: [projects.${name}] must be a table with at least a "path" field.`
    );
  }
  const { path: projectPath, check, hosts, maxRequestBytes, maxCallsPerTask, onlyTouchedTests, ...rest } = value;
  const extra = Object.keys(rest);
  if (extra.length > 0) {
    throw new ConfigError(
      "malformed",
      `${path}: [projects.${name}] has unknown field(s): ${extra.join(", ")}. ` +
        `Only path, check, hosts, maxRequestBytes, maxCallsPerTask and onlyTouchedTests are recognized.`
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
  // Issue #142: the Client's standing ruling, so it is a default on load
  // rather than something each entry has to carry. An entry written
  // before this existed is therefore governed by it too; only an
  // explicit `onlyTouchedTests = false` turns it off.
  if (onlyTouchedTests !== undefined && typeof onlyTouchedTests !== "boolean") {
    throw new ConfigError(
      "malformed",
      `${path}: [projects.${name}].onlyTouchedTests must be true or false, not ${String(onlyTouchedTests)}.`
    );
  }
  const project: ProjectConfig = {
    path: expandLeadingTilde(projectPath),
    onlyTouchedTests: onlyTouchedTests ?? true,
  };
  if (check !== undefined) project.check = check;
  if (hosts !== undefined) project.hosts = requireHosts(hosts, `${path}: [projects.${name}].hosts`);
  if (maxRequestBytes !== undefined) {
    project.maxRequestBytes = requirePositiveInteger(maxRequestBytes, `${path}: [projects.${name}].maxRequestBytes`);
  }
  if (maxCallsPerTask !== undefined) {
    project.maxCallsPerTask = requirePositiveInteger(maxCallsPerTask, `${path}: [projects.${name}].maxCallsPerTask`);
  }
  return project;
}

/** The extra hosts a project's Workers may reach through the relay
 * (issue #186). Only the shape is checked here — whether a given entry
 * ever matches anything is src/relay/allowlist.mjs's business — but an
 * empty or whitespace-only entry is refused outright rather than
 * silently never matching, since it can only be a typo. */
function requireHosts(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ConfigError(
      "malformed",
      `${label} must be an array of host names (for example ["registry.npmjs.org"]).`
    );
  }
  const hosts = (value as string[]).map((entry) => entry.trim());
  if (hosts.some((entry) => entry.length === 0)) {
    throw new ConfigError("malformed", `${label} has an empty entry; remove it or name a host.`);
  }
  return hosts;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ConfigError("malformed", `${label} must be a whole number of at least 1, not ${String(value)}.`);
  }
  return value;
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
