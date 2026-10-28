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
//   - (issue #305) "files that are documentation by extension or
//     location are never counted as unmapped", and "a touched file that
//     is itself a test is mapped to itself" - so the list the Client
//     reads names only code files that genuinely lack a test. Which file
//     is which is `classify.ts`'s answer, not this file's.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { isDocumentation, isTestFile, normalizeFile } from "./classify.ts";
import { matchesGlob } from "./glob.ts";
import type { BrokenMapping, MappedFile, TestMapEntry, TestMapReport } from "./types.ts";

/**
 * `files` resolved against `entries`.
 *
 * `projectPath` is only used to check whether a path-shaped test target
 * still exists; pass it as the project root. Omit it and `broken` comes
 * back empty - a caller with no checkout to look at reports nothing
 * rather than guessing that every mapping is broken.
 *
 * A file no entry matches lands in `unmapped` only when it is code: a
 * test file covers itself and is reported as mapped to itself, and
 * documentation is left out of all three lists, since there is no test
 * for it to be missing (issue #305). A file that *does* match an entry
 * is mapped by it either way - a project is free to point `docs/*.md` at
 * a link checker, and that mapping is honoured like any other.
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
    const path = normalizeFile(file);
    const covering: string[] = [];
    for (const entry of entries) {
      if (!matchesGlob(entry.pattern, path)) continue;
      for (const test of entry.tests) if (!covering.includes(test)) covering.push(test);
    }
    if (covering.length === 0) {
      // A test nobody has mapped yet still has a test: itself. Named in
      // `tests` too, so the brief tells the worker to run it.
      if (isTestFile(path)) covering.push(path);
      // Documentation needs none, so it is neither mapped nor missing.
      else if (isDocumentation(path)) continue;
      else {
        unmapped.push(file);
        continue;
      }
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
