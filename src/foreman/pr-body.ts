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

import { quizProblem, WRITEUP_STRING_FIELDS, WRITEUP_TITLE_MAX_LENGTH } from "../brain/index.ts";
import type { WorkerWriteup } from "../brain/index.ts";

export interface FinalMessageForCommit {
  title: string;
  body: string;
  /** false when the write-up was missing or invalid - title/body are then
   * Fabrica's own fallback wording, naming what was wrong. */
  ok: boolean;
  /** Set when ok is false: what was wrong with the write-up. */
  reason?: string;
  /** The write-up `title`/`body` were rendered from - present only when
   * `ok`. Its one reader is the pull request body for a project that
   * renders into its repository's own template (`pr-template.ts`): that
   * shape places the same fields under different headings, and a
   * worker's write-up is structured data Fabrica renders, never prose
   * Fabrica parses. */
  writeup?: WorkerWriteup;
}

/** The Client's own template (ruling 2026-10-18): the body's content
 * sections, in this order, each holding one write-up field verbatim.
 * The headings are the Client's exact words - a reviewer who did not run
 * the task reads these, so "why" leads (what the change is *for*) and
 * the engineering detail comes third. */
export const CONTENT_SECTIONS = [
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

export const ADDITIONAL_HEADING = "## Additional information";

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

/** What is wrong with a write-up's title - empty, or longer than the
 * commit subject line this project allows - or undefined when it is
 * usable. Its own function because a rebase-only round
 * (`rebase-only.ts`) publishes one section and so checks the title and
 * that section alone, and the two must not grow separate ideas of what
 * a usable title is. */
export function titleProblem(title: string): string | undefined {
  const trimmed = title.trim();
  if (trimmed.length === 0) return "the title field is empty";
  if (trimmed.length > WRITEUP_TITLE_MAX_LENGTH) {
    return `the title is ${trimmed.length} characters (at most ${WRITEUP_TITLE_MAX_LENGTH})`;
  }
  return undefined;
}

/** Everything wrong with a write-up, as one clause - or undefined when it
 * is valid. Checks only the required fields: an absent optional one is
 * not a problem, it just renders nothing.
 *
 * The quiz (issue #98) is required like any other field even though
 * nothing below renders it: it is asked of the worker for the owner's
 * sake, read on the live view, and a missing or mis-counted one is as
 * much an invalid write-up as an empty `why` - it goes down this same
 * red-attempt path, never padded or truncated to fit. */
export function writeupProblem(writeup: WorkerWriteup | undefined): string | undefined {
  if (writeup === undefined) return "the worker returned no write-up";
  const problems: string[] = [];
  for (const field of WRITEUP_STRING_FIELDS) {
    // `title` is checked by `titleProblem` below instead - empty and
    // over-long in one place, so a rebase-only round and this one can
    // never disagree about a usable title.
    if (field === "title") continue;
    if (writeup[field].trim().length === 0) problems.push(`the ${field} field is empty`);
  }
  const quiz = quizProblem(writeup.quiz);
  if (quiz !== undefined) problems.push(quiz);
  if (typeof writeup.confidence !== "number" || !Number.isFinite(writeup.confidence) || writeup.confidence < 0 || writeup.confidence > 100) {
    problems.push("the confidence field is not a number from 0 to 100");
  }
  const title = titleProblem(writeup.title);
  if (title !== undefined) problems.push(title);
  return problems.length > 0 ? problems.join("; ") : undefined;
}

/** One write-up field as a body renders it: the worker's own words, with
 * any line that is nothing but one of this template's headings dropped.
 * Exported because a project rendering into its repository's own pull
 * request template (`pr-template.ts`) places the same text under
 * different headings, and the two must not grow separate ideas of what a
 * field's text is. */
export function writeupSection(writeup: WorkerWriteup, field: keyof WorkerWriteup): string {
  const value = writeup[field];
  return typeof value === "string" ? withoutTemplateHeadings(value) : "";
}

/** "## Additional information"'s bullets, without the heading - the
 * worker's confidence and the three (or four) labelled fields the
 * reviewer reads last. Exported for the same reason `writeupSection` is:
 * a body rendered into a repository's own template carries these too,
 * and there is one definition of what they are. */
export function additionalInformationBullets(writeup: WorkerWriteup): string {
  const bullets = [bullet("Confidence", `${writeup.confidence}/100`)];
  for (const { label, field } of ADDITIONAL_BULLETS) {
    const value = writeup[field] === undefined ? undefined : withoutTemplateHeadings(writeup[field]!);
    if (value !== undefined && value.length > 0) bullets.push(bullet(label, value));
  }
  return bullets.join("\n");
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
  const sections = CONTENT_SECTIONS.map(({ heading, field }) => `${heading}\n\n${writeupSection(writeup, field)}`);
  sections.push(`${ADDITIONAL_HEADING}\n\n${additionalInformationBullets(writeup)}`);
  // The write-up rides along so a consumer that needs a DIFFERENT shape
  // of the same words - a project whose pull request body is its
  // repository's own template (issue #316) - renders from the data
  // rather than parsing the body above back apart. Only ever set on a
  // valid write-up: the fallback body is Fabrica's own wording, and
  // there is nothing to re-render.
  return { title: writeup.title.trim(), body: sections.join("\n\n"), ok: true, writeup };
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

/** The issue a pull request closes, and where it lives. `repo`
 * (`"owner/repo"`) is set only when the issue is NOT in the repository
 * the pull request itself is opened in - the case `fabrica do --issue
 * owner/repo#N` (or a pasted URL for another repository) creates. */
export interface ClosesIssue {
  number: number;
  repo?: string;
}

/** The issue a pull request for this task should close: whichever the
 * chat agent named explicitly (`Foreman.do`'s `issue` option, fetched
 * and persisted at registration - see src/foreman/task-issue.ts) takes
 * priority, since it was stated outright; otherwise whatever `taskText`
 * itself names per `issueNamedByTaskText`, which can only ever mean this
 * project's own repository. Undefined either way means this task is not
 * the whole of one issue's work, and nothing is closed. */
export function closesIssueFor(taskText: string, explicitIssue: ClosesIssue | undefined): ClosesIssue | undefined {
  if (explicitIssue !== undefined) return explicitIssue;
  const fromText = issueNamedByTaskText(taskText);
  return fromText === undefined ? undefined : { number: fromText };
}

/** The pull request body a reviewer sees - `body` with its closing line
 * first when an issue is set (the Client's template, ruling
 * 2026-10-18), unchanged otherwise. Deliberately never applied to the
 * commit message `body` also renders into (renderCommitMessage): GitHub
 * closes an issue from a merged pull request's body, not from an
 * intermediate attempt's own commit.
 *
 * An issue in another repository is named in full - `Closes
 * owner/repo#N`, which is GitHub's own documented spelling for a closing
 * keyword across repositories ("Linking a pull request to an issue":
 * `KEYWORD OWNER/REPOSITORY#ISSUE-NUMBER`). A bare `Closes #N` there
 * would close whatever issue happens to carry that number in *this*
 * repository, which is the one outcome worse than closing nothing. */
export function withClosesLine(body: string, issue: ClosesIssue | undefined): string {
  if (issue === undefined) return body;
  const named = issue.repo === undefined ? `#${issue.number}` : `${issue.repo}#${issue.number}`;
  return `Closes ${named}\n\n${body}`;
}
