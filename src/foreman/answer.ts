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

  // The LAST "questions-asked" is the round awaiting an answer; anything
  // after it (an "answers-given" from an earlier `fabrica answer` call)
  // means this round is already spent - v1's one-clarification-round
  // default, enforced here rather than left to silently re-ask.
  const askedIndex = events.map((e) => e.name).lastIndexOf("questions-asked");
  if (askedIndex === -1) {
    throw new ForemanError(
      "no-questions-pending",
      `fabrica answer: task "${taskId}" never asked a clarifying question - there is nothing to answer. ` +
        `Check \`fabrica status\`.`
    );
  }
  if (events.slice(askedIndex + 1).some((e) => e.name === "answers-given")) {
    throw new ForemanError(
      "already-answered",
      `fabrica answer: task "${taskId}" already got its one clarification round (SPEC.md's ask-first ` +
        `dial is fixed at "ask" for v1) and has moved on. Check \`fabrica status\`.`
    );
  }

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
