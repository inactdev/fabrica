// Everything the quiz writes to the record, and the exact shape of each
// event's `details`. The record is the only place any of this lives -
// a mark, a staleness flag and a re-check verdict are all events on the
// task that spawned the question, so nothing about the quiz is stored
// twice and nothing about it lives in a browser.
//
// The event names themselves are declared in src/inspector/types.ts, the
// one place the ratified event-name set is widened.

import { appendEvent } from "../record/index.ts";

/** One right/wrong mark. `index` is the question's position in its
 * task's write-up quiz (0, 1 or 2) - a question is identified by its
 * task plus that position, which is stable even when a re-check rewrites
 * its words. */
export interface QuizAnsweredDetails {
  index: number;
  right: boolean;
}

/** Why a task's questions may be outdated: a later accepted task
 * touched files this task's own accepted work touched. `touchedBy` is
 * that later task, and `files` the overlap itself - kept so the re-check
 * round can tell its worker what actually moved rather than making it
 * guess. */
export interface QuizStaleDetails {
  touchedBy: string;
  files: string[];
}

/** A re-check round's ruling on one question. `question`/`answer` carry
 * the new words for `"rewritten"` and nothing otherwise; `note` is the
 * worker's one-line reason, kept for `"retired"` above all, since a
 * retired question is gone from the rotation and the record should say
 * why. */
export interface QuizRecheckedDetails {
  index: number;
  outcome: "confirmed" | "rewritten" | "retired";
  question?: string;
  answer?: string;
  note?: string;
}

/** What one re-check round cost, in the same two terms every other
 * dollar figure on the record uses (issue #188's `costBasis`): real
 * billed money, or a flat-rate subscription's own notional estimate. */
export interface QuizRecheckCostDetails {
  costUsd: number | null;
  costBasis: "metered" | "subscription-estimate";
  startedAt: string;
}

export function appendQuizAnswer(recordHome: string, taskId: string, details: QuizAnsweredDetails): void {
  appendEvent(recordHome, { taskId, name: "quiz-answered", details });
}

export function appendQuizStale(recordHome: string, taskId: string, details: QuizStaleDetails): void {
  appendEvent(recordHome, { taskId, name: "quiz-stale", details });
}

export function appendQuizRecheck(recordHome: string, taskId: string, details: QuizRecheckedDetails): void {
  appendEvent(recordHome, { taskId, name: "quiz-rechecked", details });
}

export function appendQuizRecheckCost(recordHome: string, taskId: string, details: QuizRecheckCostDetails): void {
  appendEvent(recordHome, { taskId, name: "quiz-recheck-cost-recorded", details });
}
