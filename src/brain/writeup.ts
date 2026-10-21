// The write-up every worker returns with its work (contract/surface.ts's
// WorkerWriteup). Shared by the adapters, which ask their brain for it in
// this exact shape, and the Foreman, which checks what came back.

import type { WorkerWriteup, WriteupQuizEntry } from "./types.ts";

export const WRITEUP_TITLE_MAX_LENGTH = 60;

/** How many questions a write-up's quiz holds - exactly this many, never
 * fewer and never more (issue #98). */
export const WRITEUP_QUIZ_LENGTH = 3;

/** Every **required** field of a write-up, in the order the pull request
 * body renders them: why/what/how/outsideChanges verbatim under the
 * Client's own headings, then confidence/assumptions/expectedOutcomes/
 * deviations as labelled bullets under "Additional information"
 * (`src/foreman/pr-body.ts`). An adapter's JSON Schema uses this list as
 * its `required` array, so an *optional* field must never be added here -
 * see `WRITEUP_OPTIONAL_STRING_FIELDS`. `quiz` is last because it is the
 * one required field the pull request body does not render at all (issue
 * #98) - it is asked of the worker and shown to the owner on the live
 * view, nowhere else. */
export const WRITEUP_FIELDS = [
  "title",
  "why",
  "what",
  "how",
  "outsideChanges",
  "confidence",
  "assumptions",
  "expectedOutcomes",
  "deviations",
  "quiz",
] as const satisfies readonly (keyof WorkerWriteup)[];

/** `WRITEUP_FIELDS` minus `confidence` and `quiz` - the required fields
 * checked for being a non-empty string. `confidence` is numeric and
 * `quiz` is a list; both are checked separately. */
export const WRITEUP_STRING_FIELDS = [
  "title",
  "why",
  "what",
  "how",
  "outsideChanges",
  "assumptions",
  "expectedOutcomes",
  "deviations",
] as const satisfies readonly (keyof WorkerWriteup)[];

/** The write-up's optional string fields: offered to the worker, never
 * required of it, and omitted from the rendered body entirely when a
 * worker leaves one out (no placeholder - Client ruling 2026-10-18).
 * Kept out of `WRITEUP_FIELDS` because that list is what an adapter's
 * schema declares `required`; these are declared as properties only,
 * which both schemas need anyway since both set
 * `additionalProperties: false`. */
export const WRITEUP_OPTIONAL_STRING_FIELDS = [
  "couldNotVerify",
] as const satisfies readonly (keyof WorkerWriteup)[];

/** What is wrong with a write-up's `quiz`, as one clause - or undefined
 * when it is exactly three questions each carrying a non-empty answer
 * (issue #98).
 *
 * Takes `unknown` deliberately, even though `WorkerWriteup.quiz` is
 * typed: both adapters build a write-up out of whatever their brain
 * actually sent, and a write-up read back off the record can predate
 * this field existing at all - the same reason `writeupProblem` re-checks
 * `confidence`'s type rather than trusting the declaration.
 *
 * Nothing here looks at whether an answer is really one line. The schema
 * and the worker's brief both ask for one, but a wrapped answer is a
 * cosmetic slip, and refusing the write-up over it would cost the task a
 * whole red round - the same line `withoutTemplateHeadings` already
 * draws for a heading a worker echoed (src/foreman/pr-body.ts). */
export function quizProblem(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return value === undefined
      ? `the quiz is missing (${WRITEUP_QUIZ_LENGTH} questions, each with a one-line answer)`
      : "the quiz is not a list of questions";
  }
  if (value.length !== WRITEUP_QUIZ_LENGTH) {
    return `the quiz has ${value.length} question${value.length === 1 ? "" : "s"} (exactly ${WRITEUP_QUIZ_LENGTH} required)`;
  }
  for (const [index, entry] of value.entries()) {
    const at = `quiz question ${index + 1}`;
    if (typeof entry !== "object" || entry === null) return `${at} is not a question and answer`;
    const { question, answer } = entry as { question?: unknown; answer?: unknown };
    if (typeof question !== "string" || question.trim().length === 0) return `${at} is empty`;
    if (typeof answer !== "string" || answer.trim().length === 0) return `${at}'s answer is empty`;
  }
  return undefined;
}

/** A write-up's quiz, ready to show - or an empty list when there is
 * nothing showable: no write-up, a write-up recorded before this field
 * existed, or one whose quiz is malformed. The one reader every display
 * surface uses, so "skip a task with no quiz" is decided here once
 * rather than re-derived per page. */
export function quizEntriesOf(writeup: WorkerWriteup | null | undefined): WriteupQuizEntry[] {
  if (!writeup || quizProblem(writeup.quiz) !== undefined) return [];
  return writeup.quiz;
}
