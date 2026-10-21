// The projects.toml half of `fabrica register`: appending one
// `[projects.<name>]` table.
//
// Appending text rather than re-serializing the parsed config is
// deliberate. projects.toml is the Client's own file - his comments, his
// key order, his [caps] - and a round-trip through a TOML writer would
// quietly rewrite all of it to register one project. A new table header
// at the end of the file is always valid TOML regardless of what came
// before it, so appending is both the smallest possible edit and the
// safest one.
//
// Every write is verified by re-loading the file through the real loader,
// and rolled back to the exact prior bytes if that fails. The Client's
// registry must never be left unparseable by a command he ran to add one
// line to it.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { ConfigError, loadConfig, projectsTomlPath } from "../config/index.ts";
import { RegisterError } from "./errors.ts";

/** A TOML bare key - what `[projects.<name>]` needs `<name>` to be. A
 * name that isn't one is refused with instructions to pass --name, never
 * silently mangled into one. */
const BARE_KEY = /^[A-Za-z0-9_-]+$/;

export function isUsableProjectName(name: string): boolean {
  return BARE_KEY.test(name);
}

/** Built from a string rather than written as a literal, so no control
 * character ever appears in this file's own source. */
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

/** A TOML basic string. Only `\` and `"` need escaping for an ordinary
 * filesystem path; a control character in a directory name would too, so
 * it is handled rather than assumed away. */
function tomlString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(CONTROL_CHARS, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `"${escaped}"`;
}

export interface ExistingRegistration {
  /** The name already registered. */
  name: string;
  /** Why it collides: the same name, or a different name for this path. */
  reason: "same-name" | "same-path";
  path: string;
}

/**
 * Whatever already stands in the way of registering `name` at `path` -
 * the same name, or a different name already pointing at this same
 * repository. Both are refusals (Client ruling: "refuse in both cases
 * with a message naming what already exists; never overwrite, never
 * silently no-op"); a second name for one repository is a duplicate
 * registration the Client should hear about, not something to add
 * quietly.
 */
export function existingRegistration(
  recordHome: string,
  name: string,
  path: string
): ExistingRegistration | null {
  let projects: Record<string, { path: string }>;
  try {
    projects = loadConfig(recordHome).projects;
  } catch (err) {
    if (err instanceof ConfigError && err.code === "not-found") return null;
    if (err instanceof ConfigError) {
      throw new RegisterError(
        "registry-write-failed",
        `fabrica register: ${projectsTomlPath(recordHome)} could not be read, so nothing was registered ` +
          `and nothing on the repository was touched. ${err.message}`
      );
    }
    throw err;
  }

  if (Object.hasOwn(projects, name)) {
    return { name, reason: "same-name", path: projects[name].path };
  }
  const samePath = Object.entries(projects).find(([, project]) => project.path === path);
  return samePath ? { name: samePath[0], reason: "same-path", path: samePath[1].path } : null;
}

/**
 * Appends one `[projects.<name>]` table with `path`, `check` and
 * `onlyTouchedTests`. Returns the exact text appended, so the caller can
 * show the Client what landed in his own file rather than describing it.
 *
 * `onlyTouchedTests = true` is written out even though the loader
 * defaults it to exactly that (issue #142, Client ruling): the summary
 * this text becomes is the one moment the Client sees his new entry, so
 * a standing ruling that governs every task on the project is worth
 * showing him - and an explicit line is the one he edits to turn it
 * off.
 */
export function appendProjectEntry(opts: {
  recordHome: string;
  name: string;
  path: string;
  check: string;
}): { tomlPath: string; appended: string } {
  const tomlPath = projectsTomlPath(opts.recordHome);

  let before: string | null;
  try {
    before = readFileSync(tomlPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      before = null;
    } else {
      throw new RegisterError(
        "registry-write-failed",
        `fabrica register: ${tomlPath} could not be read: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const entry =
    `[projects.${opts.name}]\n` +
    `path = ${tomlString(opts.path)}\n` +
    `check = ${tomlString(opts.check)}\n` +
    `onlyTouchedTests = true\n`;

  // A file not ending in a newline would otherwise glue its last line to
  // the new table header; a brand new file gets no leading blank line.
  const base = before === null || before.length === 0 ? "" : before.endsWith("\n") ? before : `${before}\n`;
  const separator = base.length === 0 || base.endsWith("\n\n") ? "" : "\n";
  const appended = `${separator}${entry}`;

  try {
    writeFileSync(tomlPath, `${base}${appended}`);
  } catch (err) {
    throw new RegisterError(
      "registry-write-failed",
      `fabrica register: ${tomlPath} could not be written: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Proof, not hope: read it back through the real loader, and put the
  // Client's own file back exactly as it was if it no longer parses -
  // including removing it again if there was no file here before.
  try {
    loadConfig(opts.recordHome);
  } catch (err) {
    if (before === null) rmSync(tomlPath, { force: true });
    else writeFileSync(tomlPath, before);
    throw new RegisterError(
      "registry-write-failed",
      `fabrica register: adding [projects.${opts.name}] to ${tomlPath} left it unparseable, so it has been ` +
        `restored exactly as it was. Add the entry by hand:\n\n${entry}\n` +
        `The loader said: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return { tomlPath, appended };
}
