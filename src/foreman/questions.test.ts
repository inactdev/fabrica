import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doTask } from "./do.ts";
import { answerTask, recordAnswerDecision } from "./answer.ts";
import { ForemanError } from "./errors.ts";
import { answeredQuestionsOf, askedQuestionsOf, renderAnswerRound } from "./questions.ts";
import { readEventsForTask, readTaskFile } from "../record/index.ts";
import { OTHER_OPTION } from "../brain/index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { fixtureInspector } from "../../contract/helpers/fake-inspector.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-questions-home-"));
}

const QUESTION = { question: "Which database should this use?", options: ["Postgres", "SQLite"] };

/** A task stopped on one fixed-shape question. */
async function asking(): Promise<{ recordHome: string; taskId: string; questionId: string }> {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  const task = await doTask(recordHome, "build me an app", { project, brain: fakeBrain({ askQuestion: QUESTION }) });
  assert.equal(task.state, "asking");
  const asked = askedQuestionsOf(readEventsForTask(recordHome, task.id));
  const [questionId] = [...asked.keys()];
  return { recordHome, taskId: task.id, questionId };
}

// Issue #176: picking an option is the whole answer, and that option's
// own text is what the worker is handed.
test("an option pick is the answer the worker receives, recorded against the question's id", async () => {
  const { recordHome, taskId, questionId } = await asking();

  const decision = recordAnswerDecision(recordHome, taskId, "", { option: 2 });

  assert.deepEqual(decision, { questionId, answer: "SQLite", option: "SQLite", correction: false, resume: true, duplicate: false });
  const given = readEventsForTask(recordHome, taskId).filter((e) => e.name === "answers-given").at(-1)!;
  assert.deepEqual(given.details, { answer: "SQLite", questionId, option: "SQLite" });
  // answers.md marks which option was picked, for the Client re-reading it.
  const answers = readTaskFile(recordHome, taskId, "answers.md") ?? "";
  assert.match(answers, /- \[x\] SQLite/);
  assert.match(answers, /- \[ \] Postgres/);
  assert.match(readTaskFile(recordHome, taskId, "brief.md") ?? "", /SQLite/);
});

// The one option that needs words, and those words ARE the answer
// (Client ruling 2026-10-25).
test('"other" takes the Client\'s own words as the answer, and refuses to be picked without them', async () => {
  const { recordHome, taskId, questionId } = await asking();

  assert.throws(
    () => recordAnswerDecision(recordHome, taskId, "   ", { option: 3 }),
    (err: unknown) => err instanceof ForemanError && err.code === "missing-answer"
  );

  const decision = recordAnswerDecision(recordHome, taskId, "DuckDB, actually.", { option: 3 });
  assert.equal(decision.answer, "DuckDB, actually.");
  assert.equal(decision.option, OTHER_OPTION);
  assert.equal(decision.questionId, questionId);
});

// -m alone is what this command has always taken, and it still means
// exactly what it meant: the Client's own words, i.e. "other".
test("an answer with no option named is 'other' with those words", async () => {
  const { recordHome, taskId } = await asking();

  const decision = recordAnswerDecision(recordHome, taskId, "Neither - use Redis.", {});

  assert.equal(decision.answer, "Neither - use Redis.");
  assert.equal(decision.option, OTHER_OPTION);
});

test("an option the question does not have is refused, listing the ones it does", async () => {
  const { recordHome, taskId } = await asking();

  assert.throws(
    () => recordAnswerDecision(recordHome, taskId, "", { option: 9 }),
    (err: unknown) => err instanceof ForemanError && err.code === "invalid-option" && /1\. Postgres/.test(err.message)
  );
});

// One answer per question: an option plus words of the Client's own
// would leave the worker two answers and a coin toss.
test("a listed option paired with its own text is refused, and points at 'other'", async () => {
  const { recordHome, taskId } = await asking();

  assert.throws(
    () => recordAnswerDecision(recordHome, taskId, "but make it fast", { option: 1 }),
    (err: unknown) => err instanceof ForemanError && err.code === "invalid-option" && /drop -m/.test(err.message)
  );
});

// Issue #175, the live half of "the first answer wins": the documented
// retry of a round that threw must not answer the same question twice.
test("a second answer that names no question leaves the first one standing, and appends nothing", async () => {
  const { recordHome, taskId, questionId } = await asking();
  recordAnswerDecision(recordHome, taskId, "", { option: 1 });

  const second = recordAnswerDecision(recordHome, taskId, "No, SQLite.", {});

  assert.deepEqual(second, {
    questionId,
    answer: "Postgres",
    option: "Postgres",
    correction: false,
    resume: true,
    duplicate: true,
  });
  const answers = readTaskFile(recordHome, taskId, "answers.md") ?? "";
  assert.equal(answers.split("## Clarification").length - 1, 1, "one round, not two");
  assert.doesNotMatch(answers, /No, SQLite\./);
  assert.equal(readEventsForTask(recordHome, taskId).filter((e) => e.name === "answers-given").length, 1);
});

// Clarification 5: the Client may correct an answer by naming its
// question. The record keeps both; nothing is rewritten.
test("a correction naming the question id is kept beside the first answer, and the latest applies", async () => {
  const { recordHome, taskId, questionId } = await asking();
  recordAnswerDecision(recordHome, taskId, "", { option: 1 });

  const correction = recordAnswerDecision(recordHome, taskId, "", { option: 2, questionId });

  assert.equal(correction.correction, true);
  assert.equal(correction.answer, "SQLite");
  const events = readEventsForTask(recordHome, taskId);
  assert.equal(events.filter((e) => e.name === "answers-given").length, 2, "both answers are on the record");
  assert.equal(answeredQuestionsOf(events).get(questionId)?.answer, "SQLite", "the latest applies");
  const answers = readTaskFile(recordHome, taskId, "answers.md") ?? "";
  assert.match(answers, /Postgres/);
  assert.match(answers, /SQLite/);
});

test("a correction naming a question this task never asked is refused", async () => {
  const { recordHome, taskId } = await asking();

  assert.throws(
    () => recordAnswerDecision(recordHome, taskId, "something", { questionId: "q-000000000000" }),
    (err: unknown) => err instanceof ForemanError && err.code === "unknown-question"
  );
});

// A correction after the round has finished changes what later rounds
// are told and nothing else: v1 has one clarification round, so there is
// nothing here to restart.
test("a correction after the round finished is recorded but resumes nothing", async () => {
  const { recordHome, taskId, questionId } = await asking();
  await answerTask(recordHome, taskId, "", { option: 1, brain: fakeBrain(), inspector: fixtureInspector() });

  // Without naming the question, this is still refused exactly as before.
  assert.throws(
    () => recordAnswerDecision(recordHome, taskId, "No, SQLite.", {}),
    (err: unknown) => err instanceof ForemanError && err.code === "already-answered" && /--question/.test(err.message)
  );

  const correction = recordAnswerDecision(recordHome, taskId, "", { option: 2, questionId });
  assert.equal(correction.resume, false);
  assert.equal(answeredQuestionsOf(readEventsForTask(recordHome, taskId)).get(questionId)?.answer, "SQLite");
});

test("renderAnswerRound marks the picked option, and says when an answer was reused", () => {
  const question = { id: "q-0123456789ab", question: "Which?", options: ["Postgres", "SQLite", OTHER_OPTION] };
  const round = renderAnswerRound(question, "SQLite", { option: "SQLite" });
  assert.match(round, /## Clarification\n/);
  assert.match(round, /Q: Which\?/);
  assert.match(round, /- \[x\] SQLite/);
  assert.match(round, /A: SQLite/);

  const reused = renderAnswerRound(question, "SQLite", { option: "SQLite", auto: true });
  assert.match(reused, /answered from an earlier round/);

  // A task that asked before #176 has no options at all, and still reads.
  assert.match(renderAnswerRound(undefined, "my own words"), /A: my own words/);
});
