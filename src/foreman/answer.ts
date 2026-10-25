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
import { isOtherOption, OTHER_OPTION } from "../brain/index.ts";
import type { RecordedQuestion } from "../brain/index.ts";
import { ForemanError } from "./errors.ts";
import { answeredQuestionsOf, askedQuestionsOf, deriveBrief, renderAnswerRound } from "./questions.ts";
import { stateOf } from "./queries.ts";
import type { AnswersGivenDetails } from "./questions.ts";
import { runProductionRound } from "./do.ts";
import type { ChecksReader } from "./ci-checks.ts";
import type { TokenMinter } from "../githubapp/index.ts";
import type { DiffReader } from "./reader-round.ts";
import type { AskedDetails } from "./ask.ts";
import { requireRoomToStart } from "./caps.ts";
import { requireMeterRoomToStart } from "./meters.ts";
import type { Caps } from "../../contract/surface.ts";
import type { CheckBox } from "../brain/index.ts";
import type { FabricaTask, Inspector } from "../inspector/types.ts";

export interface AnswerDecisionOptions {
  caps?: Caps;
  /** Which question is being answered (issue #175). Omitted answers the
   * one this task is currently stopped on. Naming an id the task has
   * already answered is a **correction**: the record keeps both answers
   * and the latest applies to later rounds (Client ruling 2026-10-25,
   * "nothing is rewritten"). */
  questionId?: string;
  /** Which of the question's options the Client picked, 1-based, as the
   * record lists them - `OTHER_OPTION` last. Omitted means "other": the
   * Client's own words, which is what `-m` alone has always meant. */
  option?: number;
}

export interface AnswerDecision {
  /** The question this answered, or null for a round recorded against a
   * task that asked before questions had ids. */
  questionId: string | null;
  /** What the worker receives: the picked option's own text, or the
   * Client's own words when he picked "other". */
  answer: string;
  /** The option that was picked, verbatim - `OTHER_OPTION` whenever the
   * answer is the Client's own words. */
  option: string;
  /** True when this answered a question that already had an answer - a
   * correction rather than this task's first word on it. */
  correction: boolean;
  /** True when the question already had an answer and this call did not
   * name it, so the first answer stood and this one was not applied
   * (issue #175). Nothing was appended; `answer` is the answer that
   * stands. */
  duplicate: boolean;
  /** Whether there is a round to resume. False for a correction to a
   * question whose round already completed: the latest answer applies to
   * later rounds, and there is nothing here to restart (which is what
   * `already-answered` has always protected). */
  resume: boolean;
}

/**
 * The fast, synchronous half of answering: validates that this task is
 * actually waiting on an answer, resolves which option the Client picked
 * (issue #176), writes the round to `answers.md`, and re-derives
 * `brief.md` - everything `runRecordedAnswer` below needs to actually run
 * the round is then derivable straight from the record, so what comes
 * back is only what the caller has to *say* about the decision. Split out
 * so the CLI (issue #123) can run this part in the foreground - a bad
 * answer fails immediately, before anything is handed to a detached
 * process - while only the round's worker call, the slow part, is
 * deferred. `answerTask` (below) composes this with actually running that
 * round, which is what every library caller (the contract tests
 * included) still gets: an answer call that doesn't resolve until the
 * resumed round is done.
 *
 * Two things the returned decision tells a caller that it used to have no
 * way to know (issue #175): whether the question already had an answer,
 * in which case the first one stands and this one was not applied, and
 * whether there is actually a round to resume.
 */
export function recordAnswerDecision(
  recordHome: string,
  taskId: string,
  answerText: string,
  opts: AnswerDecisionOptions
): AnswerDecision {
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
  // Which question is being answered (issue #175). Named explicitly, it
  // may be any question this task has ever asked - that is how a
  // correction reaches an answer already given. Unnamed, it is the one
  // the task is currently stopped on.
  const asked = askedQuestionsOf(events);
  const pendingQuestion = (events[askedIndex].details as AskedDetails | undefined)?.question;
  let question: RecordedQuestion | undefined = pendingQuestion;
  if (opts.questionId !== undefined) {
    const named = asked.get(opts.questionId);
    if (!named) {
      throw new ForemanError(
        "unknown-question",
        `fabrica answer: task "${taskId}" never asked a question with id "${opts.questionId}". ` +
          `The ids it did ask are: ${[...asked.keys()].join(", ") || "none"}.`
      );
    }
    question = named;
  }

  const answered = answeredQuestionsOf(events);
  const standing = question === undefined ? undefined : answered.get(question.id);
  // A correction is deliberately only ever an answer that NAMES its
  // question: changing a decision is a thing the Client does on purpose,
  // and a plain second `fabrica answer` must keep meaning exactly what it
  // meant before - either the documented retry of a round that threw, or
  // the `already-answered` refusal below.
  const correction = standing !== undefined && opts.questionId !== undefined;

  // v1's one-clarification-round default, enforced here rather than left
  // to silently re-ask. A CORRECTION is the one thing that gets past it
  // (Client ruling 2026-10-25): the Client may change his mind about a
  // question he already answered, and the record keeps both. It changes
  // what later rounds are told, never what already ran - which is why
  // nothing is resumed for it below.
  if (answeredIndex !== -1 && roundCompleted && !correction) {
    throw new ForemanError(
      "already-answered",
      `fabrica answer: task "${taskId}" already got its one clarification round (SPEC.md's ask-first ` +
        `dial is fixed at "ask" for v1) and has moved on. Check \`fabrica status\`. ` +
        `To correct an answer it already has, name the question: ` +
        `fabrica answer ${taskId} --question <id> -m "<text>"`
    );
  }
  const resume = !(correction && roundCompleted);

  // "The first answer wins" (issue #175), on the live side: this exact
  // question already has an answer and this call did not name it, so the
  // answer on record stands and this one is not applied. Nothing is
  // appended and nothing is rewritten; the round is still resumed, which
  // is what the documented retry of a round that threw mid-flight needs
  // (see this file's header). Before #175 that retry appended a second,
  // duplicate round to `answers.md` and handed the worker the Client's
  // words twice.
  if (standing !== undefined && !correction) {
    return {
      questionId: standing.questionId,
      answer: standing.answer,
      option: standing.option,
      correction: false,
      resume,
      duplicate: true,
    };
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

  // What the worker actually receives (issue #176): the option the
  // Client picked, or - for "other", and for a question that has no
  // options because it was asked before #176 - his own words.
  const { option, answer } = resolveAnswer(taskId, question, answerText, opts.option);

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
  appendTaskFile(recordHome, taskId, "answers.md", renderAnswerRound(question, answer, { option }));

  const requestText = readTaskFile(recordHome, taskId, "request.md") ?? "";
  const answersText = readTaskFile(recordHome, taskId, "answers.md") ?? "";
  const brief = deriveBrief(requestText, answersText);
  writeTaskFile(recordHome, taskId, "brief.md", brief);

  const givenDetails: AnswersGivenDetails = {
    answer,
    ...(question ? { questionId: question.id, option } : {}),
  };
  appendEvent(recordHome, { taskId, name: "answers-given", details: givenDetails });

  return { questionId: question?.id ?? null, answer, option, correction, resume, duplicate: false };
}

/**
 * Which option the Client picked and what the worker therefore receives.
 *
 * `option` is 1-based over the question's options exactly as the record
 * lists them, `OTHER_OPTION` last. Picking a listed option makes that
 * option's own text the answer and needs no words of the Client's at
 * all; picking "other" requires them, and they *are* the answer (Client
 * ruling 2026-10-25). Passing no option at all is "other" with text,
 * which is what `fabrica answer -m "<text>"` has always meant - so every
 * existing way of answering keeps working untouched.
 */
function resolveAnswer(
  taskId: string,
  question: RecordedQuestion | undefined,
  answerText: string,
  option: number | undefined
): { option: string; answer: string } {
  const options = question?.options ?? [];
  const hasText = typeof answerText === "string" && answerText.trim().length > 0;

  if (option !== undefined) {
    if (!Number.isInteger(option) || option < 1 || option > options.length) {
      throw new ForemanError(
        "invalid-option",
        `fabrica answer: there is no option ${option} on this question. ` +
          (options.length > 0
            ? `Pick one of:\n${options.map((text, i) => `  ${i + 1}. ${text}`).join("\n")}`
            : `This question has no options to pick from - answer it with -m "<text>".`)
      );
    }
    const picked = options[option - 1];
    if (isOtherOption(picked)) {
      if (!hasText) {
        throw new ForemanError(
          "missing-answer",
          `fabrica answer: "${OTHER_OPTION}" needs your own words - they are the answer the worker receives. ` +
            `Usage: fabrica answer ${taskId} --option ${option} -m "<text>"`
        );
      }
      return { option: picked, answer: answerText };
    }
    if (hasText) {
      // One answer per question, not an option plus a second opinion:
      // whichever one the worker then used would be a coin toss.
      throw new ForemanError(
        "invalid-option",
        `fabrica answer: option ${option} ("${picked}") is the answer on its own - drop -m, ` +
          `or pick "${OTHER_OPTION}" (option ${options.length}) to answer in your own words instead.`
      );
    }
    return { option: picked, answer: picked };
  }

  if (!hasText) {
    throw new ForemanError(
      "missing-answer",
      `fabrica answer: an answer needs actual text - it becomes part of the brief the worker receives. ` +
        `Usage: fabrica answer ${taskId} -m "<text>"` +
        (options.length > 0 ? `, or pick an option with --option <1-${options.length}>.` : "")
    );
  }
  return { option: options.length > 0 ? options[options.length - 1] : OTHER_OPTION, answer: answerText };
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
  opts: {
    brain: Brain;
    inspector?: Inspector;
    checkBox?: CheckBox;
    checksReader?: ChecksReader;
    minter?: TokenMinter;
    readDiff?: DiffReader;
    caps?: Caps;
  }
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
    readDiff: opts.readDiff,
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
  opts: {
    brain: Brain;
    inspector?: Inspector;
    checkBox?: CheckBox;
    checksReader?: ChecksReader;
    minter?: TokenMinter;
    readDiff?: DiffReader;
    caps?: Caps;
    questionId?: string;
    option?: number;
  }
): Promise<FabricaTask> {
  const decision = recordAnswerDecision(recordHome, taskId, answerText, {
    caps: opts.caps,
    questionId: opts.questionId,
    option: opts.option,
  });
  // A correction to a question whose round already finished changes what
  // a later round is told and nothing else - there is no round here to
  // run, so the task is reported as it stands rather than restarted.
  if (!decision.resume) return { id: taskId, state: stateOf(readEventsForTask(recordHome, taskId)) };
  return runRecordedAnswer(recordHome, taskId, opts);
}
