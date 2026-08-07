// SPEC.md's `fabrica answer <id> -m "<text>"` (issue #8): appends a
// clarification round to a task that stopped for questions, re-derives
// brief.md from request.md plus every answer so far, and resumes the
// task through the same pipeline `doTask` would have run if it had
// never needed to ask (runProductionRound, do.ts) - just with the
// extended brief.
//
// The ask-first dial is fixed at "ask" for v1 (SPEC.md: "one
// clarification round by default"; the dial itself is out of scope for
// issue #8) - resuming here never calls brain.ask() again, regardless
// of whether the extended brief would still look ambiguous to it.
//
// "Already answered" means a round that actually DELIVERED, not merely
// one that was recorded: if runProductionRound throws before finishing,
// the task must stay resumable, not get stuck forever with the Client's
// answer on record and no way back in - see the guard below. What that
// buys is resumability and an honest error every time, NOT a guarantee
// that retrying works: a failure unrelated to the branch's own content
// (an unreachable brain, a transient error) clears once the underlying
// condition does, but one baked into the branch's history at the point
// it was first cut - no check.sh in that commit, a project path already
// wrong when the branch was made - throws identically on every retry,
// since answering again changes nothing about what is already committed
// there.

import { appendEvent, appendTaskFile, readEventsForTask, readTaskFile, writeTaskFile } from "../record/index.ts";
import type { Brain } from "../brain/index.ts";
import { ForemanError } from "./errors.ts";
import { runProductionRound } from "./do.ts";
import type { AskedDetails } from "./ask.ts";
import type { FabricaTask } from "../../contract/surface.ts";

export async function answerTask(
  recordHome: string,
  taskId: string,
  answerText: string,
  opts: { brain: Brain }
): Promise<FabricaTask> {
  const events = readEventsForTask(recordHome, taskId);
  if (events.length === 0) {
    throw new ForemanError(
      "unknown-task",
      `fabrica answer: no task "${taskId}" in this record. Check the id with \`fabrica status\`.`
    );
  }

  // The LAST "questions-asked" is the round awaiting an answer; a prior
  // "answers-given" that went on to actually deliver means this round is
  // already spent - v1's one-clarification-round default, enforced here
  // rather than left to silently re-ask. The guard keys on a COMPLETED
  // round (answers-given followed by delivered), not merely on
  // answers-given existing: if a previous `fabrica answer` call recorded
  // the answer but then runProductionRound threw before finishing, the
  // task must stay resumable - refusing here on the mere presence of
  // answers-given would leave it permanently stuck, with the Client's
  // own words already recorded but no way back in. Staying resumable is
  // all this promises; whether the retry then succeeds depends on the
  // failure (see the note at the top of this file).
  const askedIndex = events.map((e) => e.name).lastIndexOf("questions-asked");
  if (askedIndex === -1) {
    throw new ForemanError(
      "no-questions-pending",
      `fabrica answer: task "${taskId}" never asked a clarifying question - there is nothing to answer. ` +
        `Check \`fabrica status\`.`
    );
  }
  const eventsSinceAsked = events.slice(askedIndex + 1);
  const answeredIndex = eventsSinceAsked.map((e) => e.name).lastIndexOf("answers-given");
  if (answeredIndex !== -1 && eventsSinceAsked.slice(answeredIndex + 1).some((e) => e.name === "delivered")) {
    throw new ForemanError(
      "already-answered",
      `fabrica answer: task "${taskId}" already got its one clarification round (SPEC.md's ask-first ` +
        `dial is fixed at "ask" for v1) and has moved on. Check \`fabrica status\`.`
    );
  }
  // Whether THIS taskId, in THIS record home, already has a prior
  // "answers-given" that never delivered - the only evidence
  // runProductionRound trusts for choosing reopenProductionLine over
  // createProductionLine (do.ts's own comment explains why: a branch's
  // mere existence in the project isn't proof this task ever cut it).
  const isRetry = answeredIndex !== -1;

  if (!answerText || answerText.trim().length === 0) {
    throw new ForemanError(
      "missing-answer",
      `fabrica answer: an answer needs actual text - it becomes part of the brief the worker receives. ` +
        `Usage: fabrica answer ${taskId} -m "<text>"`
    );
  }

  const details = events[askedIndex].details as AskedDetails;

  // Write the human-readable record before the record event that resumes
  // the task on it - same principle as verdict.ts writing the "verdict"
  // file before "verdict-recorded": a failure between the two must never
  // leave a task looking un-answered when the Client's words are already
  // sitting on disk.
  appendTaskFile(recordHome, taskId, "answers.md", renderAnswerRound(details.questions, answerText));

  const requestText = readTaskFile(recordHome, taskId, "request.md") ?? "";
  const answersText = readTaskFile(recordHome, taskId, "answers.md") ?? "";
  const brief = deriveBrief(requestText, answersText);
  writeTaskFile(recordHome, taskId, "brief.md", brief);

  appendEvent(recordHome, { taskId, name: "answers-given", details: { answer: answerText } });

  return runProductionRound(recordHome, taskId, brief, {
    project: details.project,
    brain: opts.brain,
    totalAttempts: details.totalAttempts,
    explicitAttempts: details.explicitAttempts,
    isRetry,
  });
}

function renderAnswerRound(questions: string[], answer: string): string {
  const numbered = questions.map((question, i) => `${i + 1}. ${question}`).join("\n");
  return `## Clarification\n\nQ:\n${numbered}\n\nA: ${answer}\n\n`;
}

/** SPEC.md "The record": brief.md is "assembled from request.md plus
 * every answer so far" - the two files concatenated, with a header
 * marking where the Client's original words end and the clarifications
 * begin. */
function deriveBrief(requestText: string, answersText: string): string {
  return `${requestText}\n\n---\n\nClarifications:\n\n${answersText}`;
}
