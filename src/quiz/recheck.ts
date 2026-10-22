// The cheap worker round that re-checks an outdated quiz question
// against current master, and the only part of the quiz that spends
// money.
//
// Why a worker round at all: a question marked outdated (staleness.ts)
// was marked on file overlap alone, which says nothing about whether it
// is still true. Something has to read the code as it stands now and
// decide - confirm, rewrite, or retire - and that is a judgment, which
// means a Worker.
//
// Why `Brain.work` and not `Brain.ask`: `ask` takes no workdir by
// construction (CONTRACT rule 1 holds for it without trusting a brain's
// behavior), so it cannot read the project at all. `work` gets a
// throwaway, detached-HEAD checkout of origin's default branch
// (src/line/scratch.ts) - never a ProductionLine, since there is no task
// branch to cut, nothing to commit and nothing to deliver.
//
// How the verdicts come back: the worker writes them as JSON into its own
// workdir, which the host then reads and validates. `BrainWorkResult`
// has no free-form structured channel - `writeup` is a fixed schema for
// pull request bodies - and widening a ratified contract shape for this
// would be the wrong trade when a writable workdir is a channel every
// worker already has.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withTaskNetwork } from "../brain/index.ts";
import type { Brain } from "../brain/index.ts";
import {
  capsActive,
  costFromTranscript,
  daySpend,
  eventsByTask,
  formatUsd,
  latestMeterReading,
  networkPolicyFor,
  pauseRuleFor,
  refusalFor,
  standingOf,
  unmeasuredSpend,
} from "../foreman/index.ts";
import { createScratchCheckout, destroyScratchCheckout } from "../line/index.ts";
import type { ScratchCheckout } from "../line/index.ts";
import { readEvents } from "../record/index.ts";
import type { Caps } from "../../contract/surface.ts";
import type { PauseRule } from "../config/index.ts";
import type { FabricaEvent } from "../record/index.ts";
import { appendQuizRecheck, appendQuizRecheckCost } from "./events.ts";
import { outstandingRechecks, quizQuestionsForTask } from "./questions.ts";
import type { QuizQuestion } from "./questions.ts";

/** The file the worker writes its decisions to, in the root of its own
 * workdir. */
export const QUIZ_RECHECK_RESULT_FILE = "quiz-recheck.json";

/** How many tasks one run re-checks. A run costs one worker call per
 * task, and an accept that touches a widely-shared file can mark a lot of
 * tasks at once - so a run takes the oldest few and says what it left.
 * Any later accept picks the rest up, since every run re-derives the
 * outstanding set from the record rather than from the accept that
 * triggered it. */
export const QUIZ_RECHECK_MAX_TASKS_PER_RUN = 3;

/** What one run did, for the caller's own log - this function records
 * everything that matters on the record itself and never throws for one
 * task's failure. */
export interface QuizRecheckRun {
  /** Why nothing ran at all, when that is the case (no outdated
   * questions, or no room under the caps). */
  skipped?: string;
  /** One line per task the run handled or could not handle. */
  notes: string[];
  /** Tasks left for a later run by `QUIZ_RECHECK_MAX_TASKS_PER_RUN`. */
  deferred: number;
}

/** Whichever event last carried `details.project` - the same rule
 * `fabrica status` and the live view both read a task's project with. */
function projectOf(events: FabricaEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const details = events[i].details as { project?: string } | undefined;
    if (details?.project) return details.project;
  }
  return null;
}

/**
 * Whether there is room to spend on a re-check at all, read-only.
 *
 * The same tests `requireRoomToStart` and `requireMeterRoomToStart` make
 * - unmeasured spend anywhere on the record, the rolling day's metered
 * spend against the daily cap, and the pause rule's own view of the
 * subscription meters - but deliberately NOT calls to those functions:
 * each records a refusal event against the task it refuses, and the task
 * whose questions are being re-checked is closed, so an event saying it
 * was refused a start would be a false sentence about it.
 *
 * The per-task cap is not tested: a closed task's own ceiling was about
 * the work it was allowed to do, and a re-check is not that work. The
 * daily cap and the meters are, since both bound what this machine
 * spends over a window, whatever spends it - and a flat-rate
 * subscription's quota is exactly the budget a free-looking background
 * round could quietly drain.
 */
export function recheckRoomProblem(
  events: FabricaEvent[],
  caps: Caps | undefined,
  now: number,
  pause?: PauseRule
): string | null {
  if (pause !== undefined) {
    const standing = standingOf(latestMeterReading(events), now);
    // An unreadable or missing meter reading refuses nothing, exactly as
    // the pause rule itself fails open on one (issue #189).
    const refusal = standing.usable ? refusalFor(standing, pause) : undefined;
    if (refusal !== undefined) return `the pause rule is holding new work back: ${refusal.message}`;
  }
  if (!capsActive(caps)) return null;
  const unmeasured = unmeasuredSpend(events);
  if (unmeasured.length > 0) {
    return "a spending cap is set and earlier work's cost was never measured - record it with `fabrica cost` first";
  }
  if (caps?.perDayUsd !== undefined) {
    const { meteredUsd } = daySpend(events, now);
    if (meteredUsd >= caps.perDayUsd) {
      return `the daily cap is reached (${formatUsd(meteredUsd)} of ${formatUsd(caps.perDayUsd)})`;
    }
  }
  return null;
}

/** What the worker is asked. One brief per task, carrying every outdated
 * question that task spawned - so a task's three questions cost one
 * worker call, not three. */
export function recheckBrief(opts: {
  project: string;
  baseCommit: string;
  base: string;
  taskId: string;
  taskTitle: string;
  acceptedAt: string;
  questions: QuizQuestion[];
}): string {
  const touchedBy = opts.questions.find((question) => question.staleBecause !== null)?.staleBecause;
  const listed = opts.questions
    .map(
      (question) =>
        `[index ${question.index}]\n  Question: ${question.question}\n  Recorded answer: ${question.answer}`
    )
    .join("\n\n");
  return (
    `You are re-checking quiz questions about this project. You are not changing the project.\n\n` +
    `This working directory is a throwaway checkout of ${opts.project} at ${opts.base} ` +
    `(commit ${opts.baseCommit}) - the project exactly as it stands now. Read whatever you need from it.\n\n` +
    `Each question below was written by the worker who did the task "${opts.taskTitle}" (${opts.taskId}), ` +
    `accepted on ${opts.acceptedAt}. It was written to be asked of the owner of this codebase later, as a ` +
    `check that he understood that change.\n\n` +
    (touchedBy
      ? `Since then, later accepted work (${touchedBy.touchedBy}) changed these files, which that task had also ` +
        `changed: ${touchedBy.files.join(", ")}. So each question below may no longer be true.\n\n`
      : "") +
    `For each question, decide exactly one of:\n` +
    `- "confirmed": the question and its recorded answer are both still correct about the project as it is now.\n` +
    `- "rewritten": the question is still worth asking, but its answer or its wording is no longer right. ` +
    `Supply the new question and a new one-line answer.\n` +
    `- "retired": what it asks about is gone, so it should never be asked again.\n\n` +
    `Questions:\n\n${listed}\n\n` +
    `Write your decisions as JSON to the file \`${QUIZ_RECHECK_RESULT_FILE}\` in the root of this working ` +
    `directory, and change nothing else - no commits, and no edits to any other file:\n\n` +
    `{"verdicts":[{"index":0,"outcome":"confirmed","note":"one short line saying why"}]}\n\n` +
    `Include exactly one entry per index listed above. For "rewritten", add "question" and "answer". ` +
    `\`note\` is one short line and is required for "retired". Nothing else you write or say is read.`
  );
}

interface ParsedVerdict {
  index: number;
  outcome: "confirmed" | "rewritten" | "retired";
  question?: string;
  answer?: string;
  note?: string;
}

/**
 * The worker's answer, as far as it can be trusted. Only verdicts for
 * indexes that were actually asked about are kept, only the three known
 * outcomes, and a "rewritten" with no real replacement words is dropped
 * rather than recorded as a rewrite to nothing - a dropped verdict leaves
 * that question outdated, which is the safe direction: it stays off the
 * rotation until something does answer for it.
 */
export function parseRecheckVerdicts(raw: string, asked: number[]): ParsedVerdict[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = (parsed as { verdicts?: unknown } | null)?.verdicts;
  if (!Array.isArray(list)) return [];
  const allowed = new Set(asked);
  const seen = new Set<number>();
  const verdicts: ParsedVerdict[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const { index, outcome, question, answer, note } = entry as Record<string, unknown>;
    if (typeof index !== "number" || !allowed.has(index) || seen.has(index)) continue;
    if (outcome !== "confirmed" && outcome !== "rewritten" && outcome !== "retired") continue;
    if (outcome === "rewritten") {
      if (typeof question !== "string" || question.trim().length === 0) continue;
      if (typeof answer !== "string" || answer.trim().length === 0) continue;
    }
    seen.add(index);
    verdicts.push({
      index,
      outcome,
      ...(outcome === "rewritten" ? { question: (question as string).trim(), answer: (answer as string).trim() } : {}),
      ...(typeof note === "string" && note.trim().length > 0 ? { note: note.trim() } : {}),
    });
  }
  return verdicts;
}

/**
 * Re-checks every task with outdated quiz questions, up to
 * `QUIZ_RECHECK_MAX_TASKS_PER_RUN` of them, oldest acceptance first.
 *
 * Never throws for one task: a task whose project has moved, whose
 * checkout cannot be cut, or whose worker wrote nothing readable leaves
 * its questions outdated and a line in the returned notes. That is the
 * safe failure - an outdated question is simply not asked, so the worst
 * outcome of a failed re-check is a question the Client does not see
 * until a later run gets further.
 */
export async function runQuizRecheck(
  recordHome: string,
  opts: { brain: Brain; caps?: Caps; now?: number; maxTasks?: number }
): Promise<QuizRecheckRun> {
  const now = opts.now ?? Date.now();
  const maxTasks = opts.maxTasks ?? QUIZ_RECHECK_MAX_TASKS_PER_RUN;
  const allEvents = readEvents(recordHome);

  const room = recheckRoomProblem(allEvents, opts.caps, now, pauseRuleFor(recordHome));
  if (room !== null) return { skipped: room, notes: [], deferred: 0 };

  const byTask = eventsByTask(recordHome);
  const questionsByTask = new Map<string, QuizQuestion[]>(
    Array.from(byTask, ([taskId, events]) => [taskId, quizQuestionsForTask(taskId, events, now)] as const)
  );
  const groups = outstandingRechecks(questionsByTask);
  if (groups.length === 0) return { skipped: "no quiz question is marked outdated", notes: [], deferred: 0 };

  const run: QuizRecheckRun = { notes: [], deferred: Math.max(0, groups.length - maxTasks) };
  for (const group of groups.slice(0, maxTasks)) {
    run.notes.push(await recheckOneTask(recordHome, group.taskId, group.questions, byTask.get(group.taskId) ?? [], opts.brain));
  }
  return run;
}

async function recheckOneTask(
  recordHome: string,
  taskId: string,
  questions: QuizQuestion[],
  events: FabricaEvent[],
  brain: Brain
): Promise<string> {
  const project = projectOf(events);
  if (project === null) return `${taskId}: no project on the record, left outdated`;

  const startedAt = new Date().toISOString();
  let checkout: ScratchCheckout;
  try {
    checkout = createScratchCheckout({ project, recordHome, label: `quiz-${taskId}` });
  } catch (err) {
    return `${taskId}: could not check out current master (${(err as Error).message}), left outdated`;
  }

  try {
    const brief = recheckBrief({
      project,
      base: checkout.base,
      baseCommit: checkout.baseCommit,
      taskId,
      taskTitle: questions[0].taskTitle,
      acceptedAt: new Date(questions[0].acceptedAtMs).toISOString().slice(0, 10),
      questions,
    });
    // The same per-project network policy a production round for this
    // task would have run under - a re-check's worker box is no more
    // trusted than any other.
    const work = await withTaskNetwork(networkPolicyFor(recordHome, taskId, project), () =>
      brain.work(brief, checkout.workdir)
    );

    const { costUsd, costBasis } = costFromTranscript(work.transcript);
    appendQuizRecheckCost(recordHome, taskId, { costUsd, costBasis, startedAt });

    let raw: string;
    try {
      raw = readFileSync(join(checkout.workdir, QUIZ_RECHECK_RESULT_FILE), "utf8");
    } catch {
      return `${taskId}: the worker wrote no ${QUIZ_RECHECK_RESULT_FILE}, left outdated`;
    }

    const verdicts = parseRecheckVerdicts(
      raw,
      questions.map((question) => question.index)
    );
    for (const verdict of verdicts) appendQuizRecheck(recordHome, taskId, verdict);
    const missing = questions.length - verdicts.length;
    return (
      `${taskId}: ${verdicts.map((v) => `#${v.index} ${v.outcome}`).join(", ") || "nothing usable"}` +
      (missing > 0 ? ` (${missing} question${missing === 1 ? "" : "s"} left outdated)` : "")
    );
  } catch (err) {
    return `${taskId}: re-check failed (${(err as Error).message}), left outdated`;
  } finally {
    try {
      destroyScratchCheckout(checkout);
    } catch {
      // A checkout that could not be removed is reported by the next
      // run, which removes a leftover at the same path before cutting a
      // fresh one - it must not mask this run's own result.
    }
  }
}
