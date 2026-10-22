// Every quiz question the record holds, with where it stands - the one
// reader the live view's /quiz page and the re-check round both work
// from, so neither can disagree with the other about which questions are
// still askable.
//
// Nothing is kept anywhere: a question's words, its status and its
// schedule are all derived, on every read, from the task's own events -
// the `delivered` event's write-up for the words it was written with,
// then `quiz-rechecked`/`quiz-stale`/`quiz-answered` for everything that
// happened to it since.

import { quizEntriesOf } from "../brain/index.ts";
import type { FabricaEvent } from "../record/index.ts";
import type { WorkerWriteup } from "../../contract/surface.ts";
import { standingOfMarks } from "./schedule.ts";
import type { QuizMark, QuizStanding } from "./schedule.ts";
import type { QuizAnsweredDetails, QuizRecheckedDetails, QuizStaleDetails } from "./events.ts";

/** Where a question stands in the rotation.
 *
 * - `live`: askable the moment it is due.
 * - `outdated`: a later accepted task touched a file this question's task
 *   touched, so it may no longer be true. Never asked, still shown
 *   (Client ruling: "hiding them would hide what changed").
 * - `retired`: a re-check round decided it should not come back at all.
 */
export type QuizQuestionStatus = "live" | "outdated" | "retired";

/** One quiz question, as every surface shows it. */
export interface QuizQuestion {
  /** The task whose accepted work spawned it - shown on the card, and
   * the task every event about this question is recorded against. */
  taskId: string;
  /** Its position in that task's write-up quiz. Stable across a rewrite,
   * which is why this plus `taskId` is a question's identity. */
  index: number;
  /** That task's own write-up title - the "which task was this" line. */
  taskTitle: string;
  question: string;
  answer: string;
  /** When the Client accepted the task - the date that stays on the
   * card. */
  acceptedAtMs: number;
  status: QuizQuestionStatus;
  /** True exactly when this question may be asked right now: live, and
   * due. Computed here rather than on the page, so the rule has one
   * tested home. */
  askable: boolean;
  /** True once a re-check round has replaced this question's words. The
   * card says so: the question on screen is no longer the one the
   * worker who did the task wrote. */
  rewritten: boolean;
  /** The latest re-check round's own one-line reason, when it left one -
   * what a retired question's card shows instead of an answer prompt. */
  recheckNote: string | null;
  /** Which later task's work made this question suspect, and the files
   * the two have in common. Null when it is not outdated. */
  staleBecause: { touchedBy: string; files: string[] } | null;
  standing: QuizStanding;
}

/** The latest `delivered` event's write-up - the same rule
 * `integrations/live-view/record-view.ts` applies, kept here so the quiz
 * never depends on a presentation layer for the words it shows. */
function writeupOf(events: FabricaEvent[]): WorkerWriteup | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].name !== "delivered") continue;
    const writeup = (events[i].details as { writeup?: WorkerWriteup } | undefined)?.writeup;
    if (writeup) return writeup;
  }
  return null;
}

/** When the Client accepted this task, or null when his latest ruling
 * was anything else (including no ruling at all). An accept is terminal -
 * `recordVerdictDecision` refuses every ruling after one - so the latest
 * `verdict-recorded` being an accept is the whole test. */
export function acceptedAtOf(events: FabricaEvent[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].name !== "verdict-recorded") continue;
    if ((events[i].details as { ruling?: string } | undefined)?.ruling !== "accept") return null;
    const parsed = Date.parse(events[i].occurredAt);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parsedTime(event: FabricaEvent): number {
  const parsed = Date.parse(event.occurredAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Everything that happened to one task's questions since it was
 * accepted, indexed by question.
 *
 * Every `at` here is the event's POSITION in the task's own event list,
 * never its timestamp. The record is append-only and read in order, so
 * position is the only reliable ordering it has: `occurredAt` is
 * millisecond ISO, and a stale mark and the re-check that answers it -
 * or a rewrite and a mark - can perfectly well land in the same
 * millisecond. Timestamps are still what the schedule's arithmetic is
 * done in (`atMs`), because that is a question about elapsed time rather
 * than about which event came first. */
interface PerQuestionHistory {
  marks: Map<number, (QuizMark & { at: number })[]>;
  /** The latest re-check of each question, whatever its outcome. */
  latestRecheck: Map<number, { details: QuizRecheckedDetails; at: number }>;
  /** The latest re-check that actually replaced the words - tracked apart
   * from the above, because a `confirmed` re-check after a `rewritten`
   * one must leave the rewritten words standing. */
  latestRewrite: Map<number, { question: string; answer: string; at: number; atMs: number }>;
  stale: { details: QuizStaleDetails; at: number } | null;
}

function historyOf(events: FabricaEvent[]): PerQuestionHistory {
  const history: PerQuestionHistory = {
    marks: new Map(),
    latestRecheck: new Map(),
    latestRewrite: new Map(),
    stale: null,
  };
  for (const [at, event] of events.entries()) {
    if (event.name === "quiz-answered") {
      const details = event.details as Partial<QuizAnsweredDetails> | undefined;
      if (typeof details?.index !== "number" || typeof details.right !== "boolean") continue;
      const list = history.marks.get(details.index) ?? [];
      list.push({ right: details.right, atMs: parsedTime(event), at });
      history.marks.set(details.index, list);
    } else if (event.name === "quiz-stale") {
      const details = event.details as Partial<QuizStaleDetails> | undefined;
      history.stale = {
        details: {
          touchedBy: typeof details?.touchedBy === "string" ? details.touchedBy : "",
          files: Array.isArray(details?.files) ? details.files.filter((f): f is string => typeof f === "string") : [],
        },
        at,
      };
    } else if (event.name === "quiz-rechecked") {
      const details = event.details as Partial<QuizRecheckedDetails> | undefined;
      if (typeof details?.index !== "number") continue;
      if (details.outcome !== "confirmed" && details.outcome !== "rewritten" && details.outcome !== "retired") continue;
      history.latestRecheck.set(details.index, { details: details as QuizRecheckedDetails, at });
      if (
        details.outcome === "rewritten" &&
        typeof details.question === "string" &&
        details.question.trim().length > 0 &&
        typeof details.answer === "string" &&
        details.answer.trim().length > 0
      ) {
        history.latestRewrite.set(details.index, {
          question: details.question,
          answer: details.answer,
          at,
          atMs: parsedTime(event),
        });
      }
    }
  }
  return history;
}

/**
 * One accepted task's quiz questions. Empty for a task that was not
 * accepted, or whose write-up carries no showable quiz (one recorded
 * before the field existed, or a malformed one - `quizEntriesOf` decides
 * that once for every surface).
 *
 * `now` only decides `askable`; everything else about a question is a
 * fact about the record.
 */
export function quizQuestionsForTask(taskId: string, events: FabricaEvent[], now: number): QuizQuestion[] {
  const acceptedAtMs = acceptedAtOf(events);
  if (acceptedAtMs === null) return [];
  const writeup = writeupOf(events);
  const entries = quizEntriesOf(writeup);
  if (entries.length === 0) return [];

  const history = historyOf(events);
  return entries.map((entry, index) => {
    const rewrite = history.latestRewrite.get(index);
    const recheck = history.latestRecheck.get(index);
    const stale = history.stale;

    const retired = recheck?.details.outcome === "retired";
    // An outdated mark only counts while no re-check has answered it:
    // a confirm or a rewrite that landed after the mark cleared it, and a
    // fresh mark after that makes the question suspect all over again.
    const outdated = !retired && stale !== null && (recheck === undefined || stale.at > recheck.at);
    const status: QuizQuestionStatus = retired ? "retired" : outdated ? "outdated" : "live";

    // A rewrite makes this a different question, so the marks recorded
    // before it were about different words and the schedule starts over.
    const bornAtMs = rewrite === undefined ? acceptedAtMs : rewrite.atMs;
    const marks: QuizMark[] = (history.marks.get(index) ?? [])
      .filter((mark) => rewrite === undefined || mark.at > rewrite.at)
      .map((mark) => ({ right: mark.right, atMs: mark.atMs }));
    const standing = standingOfMarks(marks, bornAtMs);

    return {
      taskId,
      index,
      taskTitle: writeup?.title ?? "",
      question: rewrite?.question ?? entry.question,
      answer: rewrite?.answer ?? entry.answer,
      acceptedAtMs,
      status,
      askable: status === "live" && standing.dueAtMs <= now,
      rewritten: rewrite !== undefined,
      recheckNote: recheck?.details.note?.trim() ? recheck.details.note.trim() : null,
      staleBecause: outdated && stale !== null ? { touchedBy: stale.details.touchedBy, files: stale.details.files } : null,
      standing,
    };
  });
}

/** The questions a re-check round still owes a ruling on: every outdated
 * one, grouped by the task that spawned it, oldest acceptance first.
 * Derived from the whole record rather than from the accept that just
 * marked something, so any later accept picks up whatever an earlier
 * run could not finish. */
export function outstandingRechecks(
  questionsByTask: Map<string, QuizQuestion[]>
): { taskId: string; questions: QuizQuestion[] }[] {
  const groups: { taskId: string; questions: QuizQuestion[] }[] = [];
  for (const [taskId, questions] of questionsByTask) {
    const outdated = questions.filter((question) => question.status === "outdated");
    if (outdated.length > 0) groups.push({ taskId, questions: outdated });
  }
  groups.sort((a, b) => a.questions[0].acceptedAtMs - b.questions[0].acceptedAtMs);
  return groups;
}
