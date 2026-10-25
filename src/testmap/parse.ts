// Reading and writing `tests.map`'s own format (Client ruling: "plain
// text, one line per entry: glob pattern, a colon, then comma-separated
// test files or commands"). Deliberately not TOML/YAML/JSON, even though
// this project already depends on a TOML parser for projects.toml: this
// file is meant to be read and hand-edited in a diff, one line per
// mapping, with no nesting to get wrong.
//
// A line Fabrica cannot read is refused rather than skipped - see
// `errors.ts`.

import { TestMapError } from "./errors.ts";
import type { TestMapEntry } from "./types.ts";

/** The committed file's name, in the project root. */
export const TEST_MAP_FILENAME = "tests.map";

/**
 * `text` as entries, in file order. Blank lines and lines whose first
 * non-space character is `#` are comments and produce nothing.
 *
 * `source` only ever appears in an error message - the path the Client
 * would open to fix the line.
 *
 * Duplicate patterns are legal and are NOT merged here: a touched file
 * takes the union of every entry it matches (`match.ts`), so two lines
 * naming the same pattern behave exactly like one line naming both
 * their tests, and leaving them separate keeps each line's own number
 * for a broken-mapping report.
 */
export function parseTestMap(text: string, source: string = TEST_MAP_FILENAME): TestMapEntry[] {
  const entries: TestMapEntry[] = [];
  const lines = text.split("\n");

  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    const colon = trimmed.indexOf(":");
    if (colon === -1) {
      throw new TestMapError(
        "malformed-test-map",
        `${source} line ${line} is not a mapping: "${trimmed}". Every line is a glob pattern, a colon, then ` +
          `comma-separated test files or commands - for example "src/cli/*.ts: src/cli/main.test.ts". ` +
          `Start the line with "#" to comment it out.`
      );
    }

    const pattern = trimmed.slice(0, colon).trim();
    const tests = trimmed
      .slice(colon + 1)
      .split(",")
      .map((test) => test.trim())
      .filter((test) => test.length > 0);

    if (pattern.length === 0) {
      throw new TestMapError(
        "malformed-test-map",
        `${source} line ${line} has no pattern before its colon: "${trimmed}". Name the source folder or file ` +
          `pattern this mapping covers.`
      );
    }
    if (tests.length === 0) {
      throw new TestMapError(
        "malformed-test-map",
        `${source} line ${line} names no tests for "${pattern}". Name at least one test file or command after ` +
          `the colon, or delete the line - an entry mapping to nothing would read as "covered" while running ` +
          `nothing.`
      );
    }

    entries.push({ pattern, tests, line });
  }

  return entries;
}

/** Entries back as file text, one line each - what `fabrica tests-map`
 * writes. The inverse of `parseTestMap` for everything it keeps
 * (comments are not entries, so a round trip drops them). */
export function renderTestMap(entries: TestMapEntry[]): string {
  return entries.map((entry) => `${entry.pattern}: ${entry.tests.join(", ")}`).join("\n") + "\n";
}
