// Loads projects.toml: the project registry plus the global caps.
//
// The record home is always an input, never assumed (SPEC: "The record").
// Parallel workers must never share runtime state, so nothing here reads
// from a fixed `~/.fabrica` — only the outermost CLI layer picks that
// default, and it does so by passing it in like any other caller.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as TOML from "smol-toml";
import { ConfigError } from "./errors.ts";
import type { Caps, FabricaConfig, KnowledgeConfig, PauseRule, ProjectConfig, ReviewerConfig } from "./types.ts";

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
    throw tomlParseError(path, err);
  }

  if (!isTable(parsed)) {
    throw new ConfigError("malformed", `${path} must contain a TOML table at its root.`);
  }

  const {
    caps: rawCaps,
    pause: rawPause,
    projects: rawProjects,
    reviewer: rawReviewer,
    reader: rawReader,
    ...rest
  } = parsed;
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
        `and globals under [caps], [pause], [reviewer] and [reader].`
    );
  }

  const caps = parseCaps(rawCaps, path);
  const pause = parsePause(rawPause, path);
  const projects = parseProjects(rawProjects, path);
  const reviewer = parseReviewer(rawReviewer, `${path}: [reviewer]`);
  const reader = parseVendorModel(rawReader, `${path}: [reader]`);

  return {
    caps,
    pause,
    projects,
    ...(reviewer === undefined ? {} : { reviewer }),
    ...(reader === undefined ? {} : { reader }),
  };
}

/**
 * The refusal for a projects.toml that will not parse at all, written as
 * ONE line: `<path>:<line>:<column>: not valid TOML - <reason>`. Every
 * place that has to show this now shows it on a single line — `fabrica
 * doctor`'s FAIL line, `fabrica status`'s first line, and the live
 * view's banner — so the parser's own multi-line code block is dropped
 * and the path plus the line, which is what a reader needs to go fix it,
 * is promoted to the front.
 *
 * The line/column are read by duck-typing two numeric fields rather than
 * an `instanceof` against the parser's own error class: a second copy of
 * the TOML package anywhere in the tree would make `instanceof` false
 * and silently turn the line number off, and a line number is the whole
 * point here. A parser that says nothing about where still gets a
 * refusal naming the path.
 */
function tomlParseError(path: string, err: unknown): ConfigError {
  const { line, column } = err as { line?: unknown; column?: unknown };
  // "Invalid TOML document: <reason>\n\n<code block>" — the first line
  // holds the reason, and the prefix is noise next to the path below.
  const reason = ((err as Error).message ?? String(err)).split("\n")[0].replace(/^Invalid TOML document:\s*/, "");
  if (typeof line !== "number") {
    return new ConfigError("malformed", `${path} is not valid TOML: ${reason}`);
  }
  const at = typeof column === "number" ? `${line}:${column}` : `${line}`;
  return new ConfigError("malformed", `${path}:${at}: not valid TOML - ${reason}`, line);
}

/** A projects.toml that exists but cannot be used, described for
 * display: one ready-to-print line, plus the two facts a reader needs to
 * go fix it on their own. `line` is null unless the failure was the TOML
 * parse itself (see `ConfigError.line`). */
export interface ConfigProblem {
  /** Already carries the path and, when known, the line. */
  message: string;
  path: string;
  line: number | null;
}

/**
 * The config for a caller that must keep working against a broken
 * projects.toml rather than refuse — the Client's own eyes: `fabrica
 * status`, `fabrica doctor`, the live view. A file that will not parse
 * yields the same empty config a missing one does, plus the problem to
 * show; a missing file is not a problem at all (no file means no
 * registered projects and no caps, which `loadConfigOrDefault` has
 * always treated as ordinary).
 *
 * Deliberately NOT what `fabrica do`/`answer`/`verdict` use: those spend
 * real money and must refuse on a broken caps table rather than quietly
 * run with no cap at all. `loadConfig` and `src/cli/load-config.ts`'s
 * `loadConfigOrDefault` still throw for exactly that reason — readers
 * degrade loudly, spenders refuse.
 */
export function loadConfigOrProblem(recordHome: string): { config: FabricaConfig; problem: ConfigProblem | null } {
  try {
    return { config: loadConfig(recordHome), problem: null };
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    const path = projectsTomlPath(recordHome);
    const empty: FabricaConfig = { caps: {}, pause: { ...DEFAULT_PAUSE_RULE }, projects: {} };
    if (err.code === "not-found") return { config: empty, problem: null };
    return { config: empty, problem: { message: err.message, path, line: err.line } };
  }
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
  const {
    path: projectPath,
    check,
    model,
    hosts,
    maxRequestBytes,
    maxCallsPerTask,
    reviewer,
    reader,
    knowledge,
    onlyTouchedTests,
    ...rest
  } = value;
  const extra = Object.keys(rest);
  if (extra.length > 0) {
    throw new ConfigError(
      "malformed",
      `${path}: [projects.${name}] has unknown field(s): ${extra.join(", ")}. ` +
        `Only path, check, model, hosts, maxRequestBytes, maxCallsPerTask, reviewer, reader, knowledge ` +
        `and onlyTouchedTests are recognized.`
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
  // Issue #184: which model this project's Workers ask for. An empty or
  // whitespace-only value is refused rather than quietly read as "no
  // model declared" - it can only be a typo, and the difference between
  // the two is a project silently running the wrong (or the expensive)
  // model for weeks.
  if (model !== undefined && (typeof model !== "string" || model.trim().length === 0)) {
    throw new ConfigError(
      "malformed",
      `${path}: [projects.${name}].model must be a non-empty model name (for example model = "small-fast-1"), ` +
        `or be left out entirely to let the worker's own configuration decide.`
    );
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
  if (model !== undefined) project.model = (model as string).trim();
  if (hosts !== undefined) project.hosts = requireHosts(hosts, `${path}: [projects.${name}].hosts`);
  if (maxRequestBytes !== undefined) {
    project.maxRequestBytes = requirePositiveInteger(maxRequestBytes, `${path}: [projects.${name}].maxRequestBytes`);
  }
  if (maxCallsPerTask !== undefined) {
    project.maxCallsPerTask = requirePositiveInteger(maxCallsPerTask, `${path}: [projects.${name}].maxCallsPerTask`);
  }
  const ownReviewer = parseReviewer(reviewer, `${path}: [projects.${name}.reviewer]`);
  if (ownReviewer !== undefined) project.reviewer = ownReviewer;
  const ownReader = parseVendorModel(reader, `${path}: [projects.${name}.reader]`);
  if (ownReader !== undefined) project.reader = ownReader;
  const ownKnowledge = parseKnowledge(knowledge, path, `${path}: [projects.${name}.knowledge]`);
  if (ownKnowledge !== undefined) project.knowledge = ownKnowledge;
  return project;
}

/**
 * A `[projects.<name>.knowledge]` table: where this project's knowledge
 * base is, and which of its notes every brief carries. Both fields are
 * required together, for the same reason `[reviewer]` requires both of
 * its own — half of this names nothing — and the path is resolved here,
 * against the directory `projects.toml` itself sits in, so every reader
 * downstream holds an absolute path and nobody has to re-derive what a
 * relative one was relative to.
 *
 * Only the shape is checked. Whether that path exists, whether it has a
 * `notes/` folder, and whether each named note is in it are questions
 * about the disk rather than about the file, and a task is refused on
 * them (src/knowledge/, src/foreman/task-knowledge.ts) — a knowledge
 * base that is merely unmounted this minute must not make the whole
 * registry unreadable for `fabrica status`.
 */
function parseKnowledge(value: unknown, tomlPath: string, label: string): KnowledgeConfig | undefined {
  if (value === undefined) return undefined;
  if (!isTable(value)) {
    throw new ConfigError(
      "malformed",
      `${label} must be a table with a "path" field and a "notes" list.`
    );
  }
  const { path: basePath, notes, ...rest } = value;
  const extra = Object.keys(rest);
  if (extra.length > 0) {
    throw new ConfigError(
      "malformed",
      `${label} has unknown field(s): ${extra.join(", ")}. Only path and notes are recognized.`
    );
  }
  if (typeof basePath !== "string" || basePath.trim().length === 0) {
    throw new ConfigError(
      "malformed",
      `${label}.path must be the knowledge base's own folder, as a non-empty string.`
    );
  }
  if (!Array.isArray(notes) || notes.some((entry) => typeof entry !== "string")) {
    throw new ConfigError(
      "malformed",
      `${label}.notes must be a list of note names (for example ["worker-boxes"]).`
    );
  }
  const expanded = expandLeadingTilde(basePath.trim());
  return {
    // `dirname` of projects.toml rather than the record home as such:
    // "relative to projects.toml" is what the path means, and that is
    // the one fact this function can state without being told it.
    path: resolve(dirname(tomlPath), expanded),
    notes: (notes as string[]).map((entry, index) => requireNoteName(entry, `${label}.notes[${index}]`)),
  };
}

/**
 * One note name, as written. Bare names only: `.md` is appended when the
 * note is read, and the folder is read flat, so a name carrying its own
 * extension or a path separator is refused here rather than turned into
 * a lookup nobody meant (`foo.md` -> `notes/foo.md.md`, `a/b` -> outside
 * `notes/` entirely). Refusing also means no name can ever walk out of
 * the knowledge base's own `notes/` folder.
 */
function requireNoteName(value: string, label: string): string {
  const name = value.trim();
  if (name.length === 0) {
    throw new ConfigError("malformed", `${label} is empty; remove it or name a note.`);
  }
  if (name.endsWith(".md")) {
    throw new ConfigError(
      "malformed",
      `${label} is "${name}"; name notes by their bare name ("${name.slice(0, -".md".length)}") - ` +
        `the .md is added when the note is read.`
    );
  }
  if (name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    throw new ConfigError(
      "malformed",
      `${label} is "${name}"; a note name is a bare file name in the knowledge base's own notes/ folder, ` +
        `with no path in it.`
    );
  }
  return name;
}

/** A `[reviewer]` table, global or a project's own — the model
 * Inspector judges that project's test changes with. Both fields are
 * required together: half a reviewer is not something Inspector could
 * be handed, and silently ignoring the half that is there would hide a
 * typo behind "no reviewer configured". Which vendors are acceptable is
 * not this function's business (src/reviewer/resolve.ts enforces the
 * standing ruling against the Worker's own vendor); only the shape is. */
function parseReviewer(value: unknown, label: string): ReviewerConfig | undefined {
  return parseVendorModel(value, label);
}

/** The shape `[reviewer]` and `[reader]` both have: a vendor and a
 * model, both required together. One function rather than two identical
 * ones, since the two tables differ only in what the settled value is
 * then used for — `[reviewer]` is handed to Inspector as flags
 * (src/reviewer/), `[reader]` is dialled by Fabrica itself
 * (src/reader/) — and never in what a well-formed table looks like.
 * `label` is what carries the difference into every message. */
function parseVendorModel(value: unknown, label: string): { vendor: string; model: string } | undefined {
  if (value === undefined) return undefined;
  if (!isTable(value)) {
    throw new ConfigError(
      "malformed",
      `${label} must be a table with a "vendor" and a "model" field.`
    );
  }
  const { vendor, model, ...rest } = value;
  const extra = Object.keys(rest);
  if (extra.length > 0) {
    throw new ConfigError(
      "malformed",
      `${label} has unknown field(s): ${extra.join(", ")}. Only vendor and model are recognized.`
    );
  }
  return {
    vendor: requireVendorModelField(vendor, `${label}.vendor`),
    model: requireVendorModelField(model, `${label}.model`),
  };
}

function requireVendorModelField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigError("malformed", `${label} must be a non-empty string.`);
  }
  return value.trim();
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
