// Turns a worker's write-up (BrainWorkResult.writeup, structured data the
// brain returns - never parsed from its prose) into the commit message
// Fabrica writes onto the branch, and the pull request title/body
// Inspector is asked to open - the human write-up a reviewer reads, never
// the raw task text ("pull requests must read like a human wrote them").
// The layout is the Client's own template, to the heading (ruling
// 2026-10-18): Context (Why), Description (What), Changes in the
// codebase (How), Changes outside the codebase, Additional information -
// with "Closes #N" as the pull request body's first line when the task is
// the whole of one issue's work.
// Each of those headings is Fabrica's to emit, exactly once: a heading a
// worker echoed into its own field is dropped as it renders, so the body
// can never carry the same heading twice (see withoutTemplateHeadings).
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

/** The Client's own template (ruling 2026-10-18): the body's content
 * sections, in this order, each holding one write-up field verbatim.
 * The headings are the Client's exact words - a reviewer who did not run
 * the task reads these, so "why" leads (what the change is *for*) and
 * the engineering detail comes third. */
const CONTENT_SECTIONS = [
  { heading: "## Context (Why)", field: "why" },
  { heading: "## Description (What)", field: "what" },
  { heading: "## Changes in the codebase (How)", field: "how" },
  { heading: "## Changes outside the codebase", field: "outsideChanges" },
] as const satisfies readonly { heading: string; field: keyof WorkerWriteup }[];

/** "## Additional information"'s bullets, in their fixed order. A bullet
 * whose field is empty or absent is omitted entirely - no placeholder.
 * Only `couldNotVerify` is optional, so in practice it is the only one
 * that is ever dropped; the rest are required and non-empty by the time
 * anything renders them. `confidence` is handled separately, being a
 * number rather than a string. */
const ADDITIONAL_BULLETS = [
  { label: "Assumptions", field: "assumptions" },
  { label: "Expected outcomes", field: "expectedOutcomes" },
  { label: "Deviations", field: "deviations" },
  { label: "Could not verify here", field: "couldNotVerify" },
] as const satisfies readonly { label: string; field: keyof WorkerWriteup }[];

const ADDITIONAL_HEADING = "## Additional information";

/** Every heading this template owns, in the order the body renders them.
 * Each one appears in a rendered body exactly once, and only ever
 * because the code below put it there - see `withoutTemplateHeadings`. */
export const TEMPLATE_HEADINGS = [
  ...CONTENT_SECTIONS.map(({ heading }) => heading),
  ADDITIONAL_HEADING,
] as const satisfies readonly string[];

const FENCE = /^\s{0,3}(?:```|~~~)/;

/** A write-up field's own value, with any line that is nothing but one
 * of the template's headings dropped.
 *
 * Fabrica renders each heading exactly once, but a worker that echoes a
 * heading at the end (or start) of a field puts a second copy of it
 * immediately next to Fabrica's own - "## Additional information" twice
 * in a row, with nothing between (seen on a real pull request). The
 * heading is a structural marker, never content: dropping the line
 * leaves every substantive word the worker wrote untouched, where
 * refusing the write-up outright would cost the task a whole red round
 * for a cosmetic slip.
 *
 * A heading inside a fenced code block is kept exactly as written: a
 * write-up that quotes this very template as an example (or documents
 * it) is showing the heading, not emitting one, and that block is the
 * one place markdown would not read it as a heading either. An
 * occurrence inside a sentence is untouched too - only a line that is
 * the heading and nothing else goes. */
function withoutTemplateHeadings(value: string): string {
  const lines = value.split("\n");
  let inFence = false;
  const kept = lines.filter((line) => {
    if (FENCE.test(line)) {
      inFence = !inFence;
      return true;
    }
    return inFence || !TEMPLATE_HEADINGS.some((heading) => line.trim() === heading);
  });
  // Nothing removed: hand back the value as it came, so a worker's own
  // spacing is never rewritten by a pass that found nothing to do.
  if (kept.length === lines.length) return value.trim();
  // A removed line leaves a wider gap than the worker wrote; close it
  // back up to one blank line so the section reads as intended.
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** One labelled bullet, with every continuation line indented under it.
 * A worker that writes two paragraphs into `assumptions` would otherwise
 * break out of the markdown list at the blank line between them; two
 * spaces keeps it inside the bullet, and reads the same either way in a
 * commit message. */
function bullet(label: string, value: string): string {
  return `- ${label}: ${value.trim().split("\n").join("\n  ")}`;
}

/** Everything wrong with a write-up, as one clause - or undefined when it
 * is valid. Checks only the required fields: an absent optional one is
 * not a problem, it just renders nothing. */
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

/** The pull request body, and the commit message's body, as the Client's
 * template (ruling 2026-10-18): Context (Why), Description (What),
 * Changes in the codebase (How) and Changes outside the codebase, each
 * holding one write-up field verbatim, then Additional information
 * folding confidence, assumptions, expected outcomes, deviations and
 * whatever the worker could not verify into labelled bullets. The commit
 * message carries all five; only the pull request body gets the
 * "Closes #N" first line, from `withClosesLine`. */
export function finalMessageFor(writeup: WorkerWriteup | undefined, fallbackTitle: string): FinalMessageForCommit {
  const reason = writeupProblem(writeup);
  if (reason !== undefined || writeup === undefined) {
    return { title: fallbackTitle, body: `${describeInvalidWriteup(reason!)}.`, ok: false, reason };
  }
  const sections = CONTENT_SECTIONS.map(({ heading, field }) => `${heading}\n\n${withoutTemplateHeadings(writeup[field])}`);
  const bullets = [bullet("Confidence", `${writeup.confidence}/100`)];
  for (const { label, field } of ADDITIONAL_BULLETS) {
    const value = writeup[field] === undefined ? undefined : withoutTemplateHeadings(writeup[field]!);
    if (value !== undefined && value.length > 0) bullets.push(bullet(label, value));
  }
  sections.push(`${ADDITIONAL_HEADING}\n\n${bullets.join("\n")}`);
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

/** The pull request body a reviewer sees - `body` with "Closes #N" as its
 * very first line when `issue` is set (the Client's template, ruling
 * 2026-10-18), unchanged otherwise. Deliberately never applied to the
 * commit message `body` also renders into (renderCommitMessage): GitHub
 * closes an issue from a merged pull request's body, not from an
 * intermediate attempt's own commit. */
export function withClosesLine(body: string, issue: number | undefined): string {
  return issue === undefined ? body : `Closes #${issue}\n\n${body}`;
}
