// How a `ChecksReport` is said - once, here, so the task line, the
// delivery's evidence and the worker's correction can never describe the
// same read differently.
//
// Two renderings, for two audiences:
//   `summarizeChecks`     - one short phrase for a task line ("CI: 5
//                           green, rehearsal red"), per issue #267's
//                           third ask.
//   `checksOutputForWorker` - the full text a red round carries: every
//                           red check named with its log URL and the tail
//                           of its job log, which becomes the delivery's
//                           evidence and the next attempt's correction.

import type { ChecksReport } from "./types.ts";

/** The label every surface puts in front of a checks summary, so the
 * Client reads the same prefix in `fabrica status`, `fabrica watch` and
 * the live view. */
export const CHECKS_LABEL = "CI";

/** One short phrase: "5 green, rehearsal red", "3 green, 1 unknown
 * (rehearsal)", "no checks reported", "could not be read". Never
 * multi-line - every caller puts it on an existing line. */
export function summarizeChecks(
  report: ChecksReport,
  opts: { truncated?: boolean; logsSkippedForCap?: number } = {}
): string {
  if (report.verdict === "unreadable") {
    return `could not be read: ${(report.problem ?? "no reason recorded").split("\n")[0]}`;
  }
  if (report.verdict === "none") return "no checks reported";

  const red = report.concluded.filter((check) => check.red);
  const green = report.concluded.length - red.length;
  const parts: string[] = [];
  if (green > 0) parts.push(`${green} green`);
  if (red.length > 0) parts.push(`${namesOf(red.map((check) => check.name))} red`);
  if (report.unresolved.length > 0) {
    parts.push(`${report.unresolved.length} unknown (${namesOf(report.unresolved.map((check) => check.name))})`);
  }
  // Never silently partial: a capped listing or a dropped log is said
  // out loud, or a reader takes this phrase for the whole picture.
  if (opts.truncated) parts.push("more checks than one page holds, not all read");
  if (opts.logsSkippedForCap) parts.push(`${opts.logsSkippedForCap} red log(s) not fetched`);
  return parts.join(", ");
}

/** Up to three names, then "and N more" - a task line must stay one
 * line, and the full list is on the record either way. */
function namesOf(names: string[]): string {
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

/**
 * The whole of what a red read has to say, for the delivery's evidence
 * and the next worker's correction: every red check by name, its
 * conclusion, where a human reads it, and the tail of its job log where
 * one was served. Green checks are counted, not listed - a worker fixing
 * a red check gains nothing from the names of the twelve that passed.
 */
export function checksOutputForWorker(report: ChecksReport): string {
  const red = report.concluded.filter((check) => check.red);
  const green = report.concluded.length - red.length;
  const lines: string[] = [
    `The pull request's own checks on GitHub (${report.prUrl}, commit ${report.sha || "unknown"}): ` +
      `${red.length} red, ${green} green${report.unresolved.length > 0 ? `, ${report.unresolved.length} still running` : ""}.`,
  ];
  for (const check of red) {
    lines.push("");
    lines.push(`--- ${check.name} (${check.source}): ${check.conclusion}${check.url ? ` - ${check.url}` : ""}`);
    if (check.logTail !== undefined) {
      lines.push(check.logTail.trimEnd());
    } else {
      lines.push(
        "(no job log was served for this one - open the link above for the full output, or ask the Client for it)"
      );
    }
  }
  if (report.unresolved.length > 0) {
    lines.push("");
    lines.push(
      `Still running when this was read, so unjudged either way: ${report.unresolved
        .map((check) => `${check.name} (${check.status})`)
        .join(", ")}.`
    );
  }
  return lines.join("\n");
}

/** What a fix round's worker is told when the delivery it is being asked
 * to repair went red on the pull request's own checks rather than on
 * Inspector's verdict (`src/foreman/verdict.ts`'s own
 * `refusalCorrection` is the precedent this mirrors). The distinction
 * matters to the worker: these checks ran on the published branch, after
 * Inspector had already called it green, so its own local check passing
 * again proves nothing about them. */
export function checksCorrection(output: string): string {
  return (
    `${output}\n\n` +
    `These are the checks the repository runs on the pull request itself, after Inspector had already ` +
    `called this branch green - so passing the project's own check again is not evidence that they pass. ` +
    `Read the output above and fix exactly what it names.`
  );
}

/** Whether this report is one a round should be turned red by. Only a
 * concluded red does that: an unreadable API and a check that never
 * concluded are both recorded as themselves and neither is invented into
 * a failure (issue #267's fourth ask reads the same way in both
 * directions). */
export function isRedReport(report: ChecksReport): boolean {
  return report.verdict === "red";
}
