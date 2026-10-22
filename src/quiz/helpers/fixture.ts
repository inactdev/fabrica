// Test-only: the shortest path to a record home holding accepted tasks
// with real quiz questions on them. The quiz reads nothing but the
// record, so a fixture only has to append the four events that matter -
// a task, a delivery with a write-up, and a verdict.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, registerTask } from "../../record/index.ts";
import type { Delivery } from "../../inspector/types.ts";
import type { WorkerWriteup } from "../../../contract/surface.ts";

export function quizRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-quiz-"));
}

/** A write-up whose only interesting part is its quiz - every other
 * field is valid and uninteresting, since `quizEntriesOf` is what
 * decides whether the quiz is showable at all. */
export function writeupWithQuiz(title: string, quiz: { question: string; answer: string }[]): WorkerWriteup {
  return {
    title,
    why: "w",
    what: "w",
    how: "w",
    outsideChanges: "None.",
    confidence: 80,
    assumptions: "None.",
    expectedOutcomes: "o",
    deviations: "None.",
    quiz,
  };
}

export function threeQuestions(tag: string): { question: string; answer: string }[] {
  return [
    { question: `q1 of ${tag}`, answer: `a1 of ${tag}` },
    { question: `q2 of ${tag}`, answer: `a2 of ${tag}` },
    { question: `q3 of ${tag}`, answer: `a3 of ${tag}` },
  ];
}

export function fakeDelivery(files: string[]): Delivery {
  return {
    outcome: "done",
    confidence: 80,
    summary: "s",
    evidence: "e",
    assumptions: "a",
    gaps: "g",
    branch: "fabrica/x",
    files,
    gateChanges: "",
  };
}

/** One task, delivered with `quiz` and then ruled on. Returns its id. */
export function acceptedTask(
  recordHome: string,
  opts: { title: string; files: string[]; quiz?: { question: string; answer: string }[]; ruling?: string; project?: string }
): string {
  const { id } = registerTask(recordHome, opts.title);
  appendEvent(recordHome, { taskId: id, name: "work-started", details: { project: opts.project ?? "/p" } });
  appendEvent(recordHome, {
    taskId: id,
    name: "delivered",
    details: {
      outcome: "done",
      writeup: writeupWithQuiz(opts.title, opts.quiz ?? threeQuestions(opts.title)),
      delivery: fakeDelivery(opts.files),
    },
  });
  if (opts.ruling !== null) {
    appendEvent(recordHome, { taskId: id, name: "verdict-recorded", details: { ruling: opts.ruling ?? "accept" } });
  }
  return id;
}
