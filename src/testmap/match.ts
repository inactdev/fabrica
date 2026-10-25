// Resolving a set of touched files against a test map: which tests cover
// them, which of them nothing covers, and which mappings point at a test
// file that is no longer there.
//
// The three Client rulings this file implements, in his own words:
//
//   - "a touched file takes the union of every matching entry" - not
//     most-specific-wins, so a folder-wide line and a file-specific line
//     both apply and adding one can only ever add tests.
//   - "unmapped files are named in the delivery and on the status row;
//     the whole suite still runs, so nothing is skipped silently - that
//     is the loudness required."
//   - "record it as a broken mapping in the delivery and continue; same
//     visibility as unmapped."

import { existsSync } from "node:fs";
import { join } from "node:path";

import { matchesGlob } from "./glob.ts";
import type { BrokenMapping, MappedFile, TestMapEntry, TestMapReport } from "./types.ts";

/**
 * `files` resolved against `entries`.
 *
 * `projectPath` is only used to check whether a path-shaped test target
 * still exists; pass it as the project root. Omit it and `broken` comes
 * back empty - a caller with no checkout to look at reports nothing
 * rather than guessing that every mapping is broken.
 */
export function testMapReport(
  entries: TestMapEntry[],
  files: string[],
  opts: { projectPath?: string; reportedByWorker?: string } = {}
): TestMapReport {
  const mapped: MappedFile[] = [];
  const unmapped: string[] = [];
  const tests: string[] = [];

  for (const file of files) {
    const path = normalize(file);
    const covering: string[] = [];
    for (const entry of entries) {
      if (!matchesGlob(entry.pattern, path)) continue;
      for (const test of entry.tests) if (!covering.includes(test)) covering.push(test);
    }
    if (covering.length === 0) {
      unmapped.push(file);
      continue;
    }
    mapped.push({ file, tests: covering });
    for (const test of covering) if (!tests.includes(test)) tests.push(test);
  }

  const report: TestMapReport = {
    mapped,
    tests,
    unmapped,
    broken: opts.projectPath === undefined ? [] : brokenMappings(entries, opts.projectPath),
  };
  const reported = opts.reportedByWorker?.trim();
  return reported === undefined || reported.length === 0 ? report : { ...report, reportedByWorker: reported };
}

/**
 * Every mapping naming a test **file** that is not in the project.
 *
 * Only path-shaped targets are checked (`looksLikePath`): the Client's
 * ruling allows "either test file paths or commands", and there is no
 * honest way to tell whether `npm test -- --filter foo` is stale without
 * running it - which this side never does. A command is therefore never
 * reported as broken, and that limit is stated in the delivery's own
 * wording rather than papered over.
 */
export function brokenMappings(entries: TestMapEntry[], projectPath: string): BrokenMapping[] {
  const broken: BrokenMapping[] = [];
  for (const entry of entries) {
    for (const test of entry.tests) {
      if (!looksLikePath(test)) continue;
      if (existsSync(join(projectPath, test))) continue;
      broken.push({ pattern: entry.pattern, test, line: entry.line });
    }
  }
  return broken;
}

/**
 * Whether a mapping's target is a file path rather than a command to
 * run. A path here is one with no whitespace and none of the shell
 * characters a command would carry - deliberately conservative in the
 * direction of "treat it as a command": mistaking a command for a path
 * would report a working mapping as broken on every delivery, while
 * mistaking a path for a command only means one stale mapping goes
 * unreported.
 */
export function looksLikePath(test: string): boolean {
  return !/[\s|&;<>$(){}*?]/.test(test);
}

/** A touched file as the map's patterns are written: project-relative,
 * "/"-separated, no leading "./". `git diff --name-only` already gives
 * this shape; the normalization is for a hand-written caller and for
 * Windows-style separators that would otherwise match nothing. */
function normalize(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}
