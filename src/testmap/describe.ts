// Every sentence anyone reads about a test map, in one file: the notice
// a worker's brief carries, the block a delivery records, and the short
// phrase a `fabrica status` row shows. Kept together for the same reason
// src/cli/render.ts keeps the status wordings together - the brief, the
// delivery and the status row must agree about what "unmapped" means,
// and three separately-worded copies are how they stop agreeing.

import { TEST_MAP_FILENAME } from "./parse.ts";
import type { TestMapReport } from "./types.ts";

/** How many unmapped files a one-line status row names before it stops
 * counting out loud. Five, by the Client's ruling on issue #305: now
 * that documentation is not counted at all, a round's list of genuinely
 * untested code files is short enough that five names it outright far
 * more often than not, and the "and N more" tail is what keeps the line
 * from pushing the rest of a delivered task's row off the screen. */
export const STATUS_FILES_NAMED = 5;

/**
 * The notice a brief carries when the project commits a test map: the
 * lookup rule, the order to run things in, and what the Client will be
 * told either way.
 *
 * `report` is this round's own resolution when there is one to give -
 * a fix round, whose branch already has a diff, is told the concrete
 * tests up front. A first round has touched nothing yet, so there is
 * nothing honest to name and the rule itself is the whole notice;
 * inventing a list from a diff that does not exist would be exactly the
 * silent guess CONTRACT rule 4 forbids.
 *
 * This notice is why `ONLY_TOUCHED_TESTS_NOTICE` is suppressed while a
 * test map is present (src/foreman/touched-tests.ts): that one tells a
 * worker NOT to run the whole suite, this one tells it to, and a brief
 * that said both would be a brief a worker could satisfy either way.
 */
export function testMapBriefNotice(report?: TestMapReport): string {
  const parts: string[] = [
    `This project commits a test map (\`${TEST_MAP_FILENAME}\` in its root): per source folder or file pattern, ` +
      `the test files or commands that cover it. Read it. Before you deliver, run exactly the tests your touched ` +
      `files map to - the union of every pattern each of them matches - and stop and fix a failure there before ` +
      `you go any further; then run the project's whole suite the way its check runs it, and say how both went. ` +
      `List the mapped tests you actually ran in your write-up's testsRun field, one per line: it is recorded as ` +
      `your own report of what ran, and is what the Client reads instead of guessing. A touched file the map ` +
      `covers with nothing is reported to him as unmapped, so name any you hit in your write-up rather than ` +
      `leaving it to be noticed - the whole suite still runs, so nothing goes unchecked; what is missing is a ` +
      `fast test for that file, which is worth saying out loud. Only code counts there: documentation needs no ` +
      `test and is never reported (any \`*.md\`, anything under \`notes/\` or \`docs/\` at any depth, and the ` +
      `root's own dotfiles and \`LICENSE\`), and a test file you touched counts as covering itself.`,
  ];

  if (report !== undefined && report.tests.length > 0) {
    parts.push(
      `What this task has touched so far maps to these tests - run these first:\n${report.tests
        .map((test) => `  - ${test}`)
        .join("\n")}`
    );
  }
  if (report !== undefined && report.unmapped.length > 0) {
    parts.push(
      `These files this task has touched are mapped to nothing, and are already reported to the Client as ` +
        `unmapped:\n${report.unmapped.map((file) => `  - ${file}`).join("\n")}`
    );
  }

  return parts.join("\n\n");
}

/**
 * The delivery's own record of the map: the tests this round's touched
 * files mapped to, which of them the worker says it ran, the touched
 * files nothing covers, and any mapping pointing at a test file that is
 * gone. One block of plain lines, so `delivery.md` reads as a report
 * rather than as a dump of a structured field.
 *
 * Empty string when there is nothing at all to say - no map, or a map
 * that covered everything this round touched and named no missing file.
 */
export function describeTestMapReport(report: TestMapReport | undefined): string {
  if (report === undefined) return "";
  const lines: string[] = [];

  if (report.tests.length > 0) {
    lines.push(`mapped tests for this round's touched files: ${report.tests.join(", ")}`);
    lines.push(
      report.reportedByWorker === undefined
        ? "the worker reported no mapped tests as run (its own report is the only source for this; nothing here " +
            "checked it - the whole suite ran afterwards either way)"
        : `the worker's own report of which it ran (not checked against the list above):\n${indent(
            report.reportedByWorker
          )}`
    );
  }

  if (report.unmapped.length > 0) {
    lines.push(
      `touched code files ${TEST_MAP_FILENAME} maps to nothing - unmapped, never silently skipped (documentation ` +
        `is never counted here, and a test file covers itself):\n${report.unmapped
          .map((file) => `  - ${file}`)
          .join("\n")}`
    );
  }

  if (report.broken.length > 0) {
    lines.push(
      `broken mappings in ${TEST_MAP_FILENAME} - these name a test file the project does not have (a mapping ` +
        `naming a command is never checked here, so this list covers paths only):\n${report.broken
          .map((entry) => `  - line ${entry.line}, "${entry.pattern}" -> ${entry.test}`)
          .join("\n")}`
    );
  }

  return lines.join("\n");
}

/**
 * The short phrase a `fabrica status` row carries, or null when there is
 * nothing wrong worth a word on a one-line listing. Deliberately says
 * only what is missing: which tests ran belongs on the delivery, where
 * there is room for the worker's own report beside it.
 *
 * Null therefore means nothing is missing, and that is now the ordinary
 * case for a documentation-only round (issue #305): `report.unmapped`
 * holds code files only, so a task that touched nothing but prose says
 * nothing at all here rather than listing its whole diff.
 */
export function describeTestMapNote(report: TestMapReport | undefined): string | null {
  if (report === undefined) return null;
  const parts: string[] = [];
  if (report.unmapped.length > 0) {
    parts.push(`${count(report.unmapped.length, "touched code file")} unmapped (${nameSome(report.unmapped)})`);
  }
  if (report.broken.length > 0) {
    parts.push(`${count(report.broken.length, "broken mapping")} (${nameSome(report.broken.map((entry) => entry.test))})`);
  }
  return parts.length === 0 ? null : `${TEST_MAP_FILENAME}: ${parts.join(", ")}`;
}

function count(howMany: number, noun: string): string {
  return `${howMany} ${noun}${howMany === 1 ? "" : "s"}`;
}

/** The first few names, then how many went unnamed - a status row is one
 * line, and a task that touched twenty unmapped files would otherwise
 * push everything after it out of sight. Shared by the unmapped list and
 * the broken-mapping list on purpose: one line, one shape, whichever of
 * the two is being counted. */
function nameSome(names: string[]): string {
  if (names.length <= STATUS_FILES_NAMED) return names.join(", ");
  const rest = names.length - STATUS_FILES_NAMED;
  return `${names.slice(0, STATUS_FILES_NAMED).join(", ")}, and ${rest} more`;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
