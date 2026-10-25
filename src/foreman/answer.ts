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
// "Already answered" means a round that actually completed with a
// delivery or an Inspector refusal, not merely one that was recorded:
// if runProductionRound throws before finishing,
// the task must stay resumable, not get stuck forever with the Client's
// answer on record and no way back in - see the guard below. What that
// buys is resumability and an honest error every time, NOT a guarantee
// that retrying works: a failure unrelated to the branch's own content
// (an unreachable brain, a transient error) clears once the underlying
// condition does, but one baked into the branch's history at the point
// it was first cut - no check.sh in that commit, a project path already
// wrong when the branch was made - throws identically on every retry,
// since answering again changes nothing about what is already committed
// there. A failure BEFORE the line was ever cut is the one case that is
// fully clean: nothing is committed anywhere yet, so the retry runs as a
// genuine first round (see `isRetry` below).

import { appendEvent, appendTaskFile, readEventsForTask, readTaskFile, writeTaskFile } from "../record/index.ts";
import type { Brain } from "../brain/index.ts";
import { ForemanError } from "./errors.ts";
import { runProductionRound } from "./do.ts";
import type { ChecksReader } from "./ci-checks.ts";
import type { TokenMinter } from "../githubapp/index.ts";
import type { AskedDetails } from "./ask.ts";
import { requireRoomToStart } from "./caps.ts";
import { requireMeterRoomToStart } from "./meters.ts";
import type { Caps } from "../../contract/surface.ts";
import type { CheckBox } from "../brain/index.ts";
import type { FabricaTask, Inspector } from "../inspector/types.ts";

/**
 * The fast, synchronous half of answering: validates that this task is
 * actually waiting on an answer, writes the round to `answers.md`, and
 * re-derives `brief.md` - everything `runRecordedAnswer` below needs to
 * actually run the round is then derivable straight from the record, so
 * this returns nothing. Split out so the CLI (issue #123) can run this
 * part in the foreground - a bad answer fails immediately, before
 * anything is handed to a detached process - while only the round's
 * worker call, the slow part, is deferred. `answerTask` (below) composes
 * this with actually running that round, which is what every library
 * caller (the contract tests included) still gets: an answer call that
 * doesn't resolve until the resumed round is done.
 */
export function recordAnswerDecision(
  recordHome: string,
  taskId: string,
  answerText: string,
  opts: { caps?: Caps }
): void {
  const events = readEventsForTask(recordHome, taskId);
  if (events.length === 0) {
    throw new ForemanError(
      "unknown-task",
      `fabrica answer: no task "${taskId}" in this record. Check the id with \`fabrica status\`.`
    );
  }

  // The LAST "questions-asked" is the round awaiting an answer; a prior
  // "answers-given" that went on to a delivery or an Inspector refusal
  // means this round is already spent - v1's one-clarification-round
  // default, enforced here rather than left to silently re-ask. The guard
  // keys on a COMPLETED round, not merely on answers-given existing: if a
  // previous `fabrica answer` call recorded
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
  const roundCompleted = eventsSinceAsked.slice(answeredIndex + 1).some(
    (event) =>
      event.name === "delivered" ||
      (event.name === "inspection-finished" &&
        (event.details as { verdict?: string } | undefined)?.verdict === "refused")
  );
  if (answeredIndex !== -1 && roundCompleted) {
    throw new ForemanError(
      "already-answered",
      `fabrica answer: task "${taskId}" already got its one clarification round (SPEC.md's ask-first ` +
        `dial is fixed at "ask" for v1) and has moved on. Check \`fabrica status\`.`
    );
  }
  // Proof, from THIS taskId's own record in THIS record home, that a
  // ProductionLine was genuinely cut for it once - "line-cut", which
  // runProductionRound appends the moment createProductionLine returns.
  // That is the only evidence it trusts for choosing
  // reopenProductionLine over createProductionLine (do.ts's own comment
  // explains why: a branch's mere existence in the project isn't proof
  // this task ever cut it).
  //
  // Deliberately not "answers-given", which is appended below, BEFORE
  // the line is cut: a resume that died on the cut itself (a moved
  // project path, a stale .git/index.lock) leaves no branch behind, so
  // it has to retry as a genuine first round. Keyed on the answer, it
  // would instead reopen a branch that never existed and fail with
  // `no-such-branch` on every later attempt, stuck for good.
  const isRetry = events.some((e) => e.name === "line-cut");

  if (!answerText || answerText.trim().length === 0) {
    throw new ForemanError(
      "missing-answer",
      `fabrica answer: an answer needs actual text - it becomes part of the brief the worker receives. ` +
        `Usage: fabrica answer ${taskId} -m "<text>"`
    );
  }

  const details = events[askedIndex].details as AskedDetails;

  // Rule 10, before the answer is recorded: a refused resume leaves the
  // task exactly as resumable as it was, so the same `fabrica answer`
  // works once there is room again.
  requireRoomToStart(recordHome, taskId, opts.caps, { project: details.project });
  // Issue #189's pause rule, the same way and for the same reason: a
  // refused resume leaves the task as resumable as it was.
  requireMeterRoomToStart(recordHome, taskId, { project: details.project });

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
}

/**
 * Runs the round a prior `recordAnswerDecision` call already validated
 * and recorded - `project`/`totalAttempts`/`explicitAttempts` come back
 * off the task's own `"questions-asked"` event (same as before the
 * split), `isRetry` off whether `"line-cut"` is on the record, and the
 * brief itself off `request.md` + `answers.md`, all re-derived here
 * rather than threaded through a parameter - the same reason
 * `verdict.ts`'s `runRecordedFix` re-derives its own round's inputs:
 * it's what lets the CLI (issue #123) hand this off to a detached
 * process with nothing to serialize beyond `recordHome`/`taskId`.
 */
export async function runRecordedAnswer(
  recordHome: string,
  taskId: string,
  opts: { brain: Brain; inspector?: Inspector; checkBox?: CheckBox; checksReader?: ChecksReader; minter?: TokenMinter; caps?: Caps }
): Promise<FabricaTask> {
  const events = readEventsForTask(recordHome, taskId);
  const askedIndex = events.map((e) => e.name).lastIndexOf("questions-asked");
  const details = events[askedIndex].details as AskedDetails;
  const isRetry = events.some((e) => e.name === "line-cut");

  const requestText = readTaskFile(recordHome, taskId, "request.md") ?? "";
  const answersText = readTaskFile(recordHome, taskId, "answers.md") ?? "";
  const brief = deriveBrief(requestText, answersText);

  // brief.md keeps the task's own words, and so does this: the worker's
  // copy - the standing question rule 11 requires, plus whatever the
  // project's own settings add (issue #142) - is built inside
  // runProductionRound, once the project is resolved, so a resumed
  // round and a first attempt can't resolve it differently.
  return runProductionRound(recordHome, taskId, brief, {
    project: details.project,
    brain: opts.brain,
    totalAttempts: details.totalAttempts,
    explicitAttempts: details.explicitAttempts,
    isRetry,
    inspector: opts.inspector,
    checkBox: opts.checkBox,
    checksReader: opts.checksReader,
    minter: opts.minter,
    caps: opts.caps,
  });
}

/** Every library caller's shape (contract tests included): an answer
 * call that doesn't resolve until the resumed round is done.
 * `src/cli/answer-command.ts` is the one caller that wants the two
 * halves apart - see `recordAnswerDecision`/`runRecordedAnswer` above. */
export async function answerTask(
  recordHome: string,
  taskId: string,
  answerText: string,
  opts: { brain: Brain; inspector?: Inspector; checkBox?: CheckBox; checksReader?: ChecksReader; minter?: TokenMinter; caps?: Caps }
): Promise<FabricaTask> {
  recordAnswerDecision(recordHome, taskId, answerText, { caps: opts.caps });
  return runRecordedAnswer(recordHome, taskId, opts);
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
