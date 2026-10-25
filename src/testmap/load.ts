// Reading the committed `tests.map` off a project, and writing a
// generated one. The only file in this module that touches a disk.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseTestMap, renderTestMap, TEST_MAP_FILENAME } from "./parse.ts";
import type { TestMapEntry } from "./types.ts";

/** Where a project's test map lives: its root, always this name. Not
 * configurable on purpose - the point of a committed map is that anyone
 * reading the repository finds it without being told where to look. */
export function testMapPath(projectPath: string): string {
  return join(projectPath, TEST_MAP_FILENAME);
}

/**
 * The project's test map, or `null` when it has none - the ordinary case
 * for a project that never ran `fabrica tests-map`, and the one that
 * leaves every brief and delivery exactly as they were before this
 * existed.
 *
 * Throws `TestMapError("malformed-test-map")` when the file is there but
 * a line cannot be read. Loud rather than lenient, per the standing
 * ruling: a half-read map would name fewer tests in the brief and report
 * more files as unmapped, both silently.
 */
export function readTestMap(projectPath: string): TestMapEntry[] | null {
  const path = testMapPath(projectPath);
  if (!existsSync(path)) return null;
  return parseTestMap(readFileSync(path, "utf8"), TEST_MAP_FILENAME);
}

/** Writes `entries` as the project's test map, under `header` (already
 * comment-prefixed by the caller). Overwrites - the CLI is what decides
 * whether overwriting is allowed. */
export function writeTestMap(projectPath: string, entries: TestMapEntry[], header: string): void {
  const text = header.endsWith("\n") ? header : `${header}\n`;
  writeFileSync(testMapPath(projectPath), `${text}\n${renderTestMap(entries)}`);
}
