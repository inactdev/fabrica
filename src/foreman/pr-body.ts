// Turns a worker's write-up (BrainWorkResult.writeup, structured data the
// brain returns - never parsed from its prose) into the commit message
// Fabrica writes onto the branch, and the pull request title/body
// Inspector is asked to open - the human write-up a reviewer reads, never
// the raw task text ("pull requests must read like a human wrote them").
// A missing or invalid write-up still gets a commit - the attempt loop
// commits every attempt and makes this one red (attempts.ts) - so this
// always returns something to commit, falling back to a label naming
// what is wrong rather than ever reaching for the task's own words.

import { WRITEUP_STRING_FIELDS, WRITEUP_TITLE_MAX_LENGTH } from "../brain/index.ts";
import type { WorkerWriteup } from "../brain/index.ts";

export interface FinalMessageForCommit {
  title: string;
  body: string;
  /** false when the write-up was missing or invalid - title/body are then
   * Fabrica's own fallback wording, naming what was wrong. */
  ok: boolean;
  /** Set when ok is false: what was wrong with the write-up. */
  reason?: string;
}

const SECTION_NAMES = { what: "What", why: "Why", how: "How" } as const;

/** Everything wrong with a write-up, as one clause - or undefined when it
 * is valid. */
export function writeupProblem(writeup: WorkerWriteup | undefined): string | undefined {
  if (writeup === undefined) return "the worker returned no write-up";
  const problems: string[] = [];
  for (const field of WRITEUP_STRING_FIELDS) {
    if (writeup[field].trim().length === 0) problems.push(`the ${field} field is empty`);
  }
  if (typeof writeup.confidence !== "number" || !Number.isFinite(writeup.confidence) || writeup.confidence < 0 || writeup.confidence > 100) {
    problems.push("the confidence field is not a number from 0 to 100");
  }
  const title = writeup.title.trim();
  if (title.length > WRITEUP_TITLE_MAX_LENGTH) {
    problems.push(`the title is ${title.length} characters (at most ${WRITEUP_TITLE_MAX_LENGTH})`);
  }
  return problems.length > 0 ? problems.join("; ") : undefined;
}

/** What a red attempt, its receipt, and a failure report say. */
export function describeInvalidWriteup(reason: string): string {
  return `write-up invalid: ${reason}`;
}

/** The pull request body, and the commit message's body, as exactly four
 * sections (issues #185/#194): What, Why, How verbatim, then one final
 * "What to look at" that gathers everything a reviewer should weigh -
 * the worker's own confidence, its assumptions, what it expects to
 * happen, and what it deviated from the request. */
export function finalMessageFor(writeup: WorkerWriteup | undefined, fallbackTitle: string): FinalMessageForCommit {
  const reason = writeupProblem(writeup);
  if (reason !== undefined || writeup === undefined) {
    return { title: fallbackTitle, body: `${describeInvalidWriteup(reason!)}.`, ok: false, reason };
  }
  const sections = (["what", "why", "how"] as const).map((field) => `${SECTION_NAMES[field]}:\n${writeup[field].trim()}`);
  sections.push(
    [
      "What to look at:",
      `Confidence: ${writeup.confidence}/100`,
      "",
      `Assumptions:\n${writeup.assumptions.trim()}`,
      "",
      `Expected outcomes:\n${writeup.expectedOutcomes.trim()}`,
      "",
      `Deviations:\n${writeup.deviations.trim()}`,
    ].join("\n")
  );
  return { title: writeup.title.trim(), body: sections.join("\n\n"), ok: true };
}

export function renderCommitMessage(message: FinalMessageForCommit): string {
  return `${message.title}\n\n${message.body}`;
}

/** Matches only when `taskText` opens with this exact prefix - naming the
 * issue as the whole of the task's work, not merely mentioning one in
 * passing ("the first half of #186" does not match). */
const ISSUE_PREFIX = /^Issue #(\d+):/;

/** The issue number a task's own text names as the whole of its work, or
 * undefined when it doesn't. */
export function issueNamedByTaskText(taskText: string): number | undefined {
  const match = ISSUE_PREFIX.exec(taskText);
  return match ? Number(match[1]) : undefined;
}

/** The issue a pull request for this task should close: whichever the
 * chat agent named explicitly (`Foreman.do`'s `issue` option, persisted
 * at registration - see src/foreman/ask.ts) takes priority, since it was
 * stated outright; otherwise whatever `taskText` itself names per
 * `issueNamedByTaskText`. Undefined either way means this task is not
 * the whole of one issue's work, and nothing is closed. */
export function closesIssueFor(taskText: string, explicitIssue: number | undefined): number | undefined {
  return explicitIssue ?? issueNamedByTaskText(taskText);
}

/** The pull request body a reviewer sees - `body` with one trailing
 * "Closes #N" line when `issue` is set, unchanged otherwise. Deliberately
 * never applied to the commit message `body` also renders into
 * (renderCommitMessage): GitHub closes an issue from a merged pull
 * request's body, not from an intermediate attempt's own commit. */
export function withClosesLine(body: string, issue: number | undefined): string {
  return issue === undefined ? body : `${body}\n\nCloses #${issue}`;
}
