// The clarifying step's record side (issue #175): which of this task's
// questions already have an answer, and how an answer round is written
// down. The shape of a question itself, and its id, live in
// `src/brain/ask-shape.ts` - the adapters need those too.
//
// "The first answer wins" reaches across every round of one task -
// resumed and fix rounds alike - and no further (Client ruling
// 2026-10-25): a standing answer that should apply everywhere belongs in
// the knowledge base, not in one task's record. That scope is why every
// lookup here is derived from the task's own events rather than held in
// memory: a fix round runs in a different process from the one that
// asked, so the record is the only thing both can agree on.

import { appendEvent, appendTaskFile, readEventsForTask, readTaskFile, writeTaskFile } from "../record/index.ts";
import { isOtherOption } from "../brain/index.ts";
import type { RecordedQuestion } from "../brain/index.ts";
import type { FabricaEvent } from "../inspector/types.ts";
import type { AskedDetails, QuestionAutoAnsweredDetails } from "./ask.ts";

/** One answer as the record holds it. `option` is the option the Client
 * picked, verbatim; `answer` is what the machine actually receives -
 * the option's own text, or the Client's own words when he picked
 * "other" (Client ruling 2026-10-25: "picking other requires free text,
 * and that text is the answer the machine receives"). */
export interface AnswerRecord {
  questionId: string;
  option: string;
  answer: string;
  occurredAt: string;
}

/** Everything the `"answers-given"` event's `details` carries. `answer`
 * keeps its name and meaning from issue #8 - every existing reader of
 * this event reads exactly that field - and the question it answers is
 * beside it. */
export interface AnswersGivenDetails {
  answer: string;
  /** The question this answers, or omitted on a round recorded before
   * questions had ids. The record is append-only: nothing is backfilled. */
  questionId?: string;
  /** The option picked, verbatim, or omitted for the same reason. */
  option?: string;
}

/** Every question this task has been asked, by id, in the order they
 * were asked. A question asked twice appears once - that is the point of
 * the id. */
export function askedQuestionsOf(events: readonly FabricaEvent[]): Map<string, RecordedQuestion> {
  const asked = new Map<string, RecordedQuestion>();
  for (const event of events) {
    if (event.name !== "questions-asked") continue;
    const question = (event.details as AskedDetails | undefined)?.question;
    if (question?.id) asked.set(question.id, question);
  }
  return asked;
}

/**
 * Every answer this task has, by question id - the **latest** answer for
 * each, since the Client may correct one with a new `fabrica answer`
 * naming the same id and the record keeps both (Client ruling
 * 2026-10-25: "the record keeps both and the latest applies to later
 * rounds; nothing is rewritten").
 *
 * An answer round recorded before questions had ids carries none, and is
 * skipped here: it was the whole of that task's one clarification round,
 * already folded into `brief.md`, and there is no id for it to win under.
 */
export function answeredQuestionsOf(events: readonly FabricaEvent[]): Map<string, AnswerRecord> {
  const answers = new Map<string, AnswerRecord>();
  for (const event of events) {
    if (event.name !== "answers-given") continue;
    const details = event.details as AnswersGivenDetails | undefined;
    if (!details?.questionId || typeof details.answer !== "string") continue;
    answers.set(details.questionId, {
      questionId: details.questionId,
      option: details.option ?? details.answer,
      answer: details.answer,
      occurredAt: event.occurredAt,
    });
  }
  return answers;
}

/** The answer this task already has for `questionId`, or undefined. What
 * makes a re-asked question answer itself instead of stopping the task
 * for a second time. */
export function answerFor(events: readonly FabricaEvent[], questionId: string): AnswerRecord | undefined {
  return answeredQuestionsOf(events).get(questionId);
}

/**
 * "The first answer wins" (issue #175), applied at an ask: when this
 * task's record already holds an answer for `question`'s id, that answer
 * is reused - written down as a real answer round, so `brief.md` carries
 * it exactly as an answered round would - and the derived brief is
 * returned. Null means this is a question the task has never answered,
 * and the Client has to be asked.
 *
 * The reuse itself is never silent *to the Client*: it lands on the
 * record as `"question-auto-answered"`, which `fabrica status` counts. It
 * is silent to the machine, which simply receives the answer.
 *
 * Reachability, plainly: a Fabrica task asks once, on its first pass
 * (SPEC.md step 2; a resumed round and a fix round deliberately never
 * call `ask()` again - see `answer.ts`'s header), so on that pass this
 * finds nothing. It is written against the record rather than against
 * anything held in memory precisely so that the guarantee holds for any
 * round that *does* ask, in whatever process, without that round having
 * to know this one happened. The live half of the same rule today is on
 * the answer side (`recordAnswerDecision`'s duplicate branch).
 */
export function autoAnswerFromRecord(
  recordHome: string,
  taskId: string,
  question: RecordedQuestion
): { answer: string; brief: string } | null {
  const already = answerFor(readEventsForTask(recordHome, taskId), question.id);
  if (!already) return null;

  const autoDetails: QuestionAutoAnsweredDetails = {
    questionId: question.id,
    question: question.question,
    answer: already.answer,
    answeredAt: already.occurredAt,
  };
  appendEvent(recordHome, { taskId, name: "question-auto-answered", details: autoDetails });
  appendTaskFile(
    recordHome,
    taskId,
    "answers.md",
    renderAnswerRound(question, already.answer, { option: already.option, auto: true })
  );
  const brief = deriveBrief(
    readTaskFile(recordHome, taskId, "request.md") ?? "",
    readTaskFile(recordHome, taskId, "answers.md") ?? ""
  );
  writeTaskFile(recordHome, taskId, "brief.md", brief);
  const givenDetails: AnswersGivenDetails = {
    answer: already.answer,
    questionId: question.id,
    option: already.option,
  };
  appendEvent(recordHome, { taskId, name: "answers-given", details: givenDetails });
  return { answer: already.answer, brief };
}

/** How a round is written into `answers.md`: the question, its options
 * with the picked one marked, and the answer the worker receives. Plain
 * markdown, since this file is read by the Client as often as by the
 * brief that quotes it. */
export function renderAnswerRound(
  question: RecordedQuestion | undefined,
  answer: string,
  opts: { option?: string; auto?: boolean } = {}
): string {
  const how = opts.auto ? " (answered from an earlier round - the same question was asked again)" : "";
  if (!question) {
    // A task whose "questions-asked" event predates issue #176 carries
    // free-form question text and no options - still answerable, and
    // rendered the way it always was.
    return `## Clarification${how}\n\nA: ${answer}\n\n`;
  }
  const options = question.options.map((option) => `- ${option === opts.option ? "[x]" : "[ ]"} ${option}`).join("\n");
  return `## Clarification${how}\n\nQ: ${question.question}\n\n${options}\n\nA: ${answer}\n\n`;
}

/** Whether `option` is the "other" the Client has to write his own words
 * for - re-exported here so the answer path has one import. */
export { isOtherOption };

/** SPEC.md "The record": brief.md is "assembled from request.md plus
 * every answer so far" - the two files concatenated, with a header
 * marking where the Client's original words end and the clarifications
 * begin. Here rather than in `answer.ts` so `ask.ts` can derive a brief
 * for a question it answered from the record without importing the
 * module that imports `do.ts`, which imports `ask.ts`. */
export function deriveBrief(requestText: string, answersText: string): string {
  return `${requestText}\n\n---\n\nClarifications:\n\n${answersText}`;
}
