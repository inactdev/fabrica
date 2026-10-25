import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAndAsk } from "./ask.ts";
import type { AskedDetails, AskRejectedDetails, QuestionAutoAnsweredDetails } from "./ask.ts";
import { autoAnswerFromRecord } from "./questions.ts";
import { recordAnswerDecision } from "./answer.ts";
import { ForemanError } from "./errors.ts";
import { readEventsForTask, readTaskFile } from "../record/index.ts";
import { OTHER_OPTION, QUESTION_ID_PATTERN } from "../brain/index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-ask-home-"));
}

test("registerAndAsk registers the task and writes brief.md before asking anything", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");

  const result = await registerAndAsk(recordHome, "small change", { project, brain: fakeBrain() });

  assert.equal(readTaskFile(recordHome, result.taskId, "request.md"), "small change");
  assert.equal(readTaskFile(recordHome, result.taskId, "brief.md"), "small change");
  assert.deepEqual(result.questions, []);
  assert.equal(result.brief, "small change");
});

test("registerAndAsk calls brain.ask() exactly once with the bare task text", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  const brain = fakeBrain();

  await registerAndAsk(recordHome, "small change", { project, brain });

  assert.deepEqual(brain.askCalls, ["small change"]);
  assert.equal(brain.calls, 0, "ask() must never call work()");
});

test("registerAndAsk returns the question and records it with its options and id, when the brain asks", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  const brain = fakeBrain({ askQuestion: { question: "What database should this use?", options: ["Postgres", "SQLite"] } });

  const result = await registerAndAsk(recordHome, "build an app", { project, brain });

  assert.deepEqual(result.questions, ["What database should this use?"]);
  assert.deepEqual(result.question?.options, ["Postgres", "SQLite", OTHER_OPTION]);
  assert.match(result.question!.id, QUESTION_ID_PATTERN);

  const events = readEventsForTask(recordHome, result.taskId);
  assert.deepEqual(
    events.map((e) => e.name),
    ["task-received", "ask-cost-recorded", "questions-asked"]
  );
  const details = events.find((e) => e.name === "questions-asked")!.details as AskedDetails;
  // The one-element free-form list stays beside the structured question,
  // so every pre-#176 reader of this event keeps working.
  assert.deepEqual(details.questions, ["What database should this use?"]);
  assert.deepEqual(details.question, result.question);
  assert.equal(details.project, project);
  assert.equal(details.totalAttempts, 2);
  assert.equal(details.explicitAttempts, false);
});

// Issue #176: free-form prose is not an ask any more. It is rejected,
// the machine is told why and asked again inside the same pass, and the
// pass only stops once a question arrives in the fixed shape.
test("registerAndAsk rejects a free-form ask, tells the machine why, and takes its reshaped question", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  const brain = fakeBrain({
    askQuestion: (call) =>
      call === 1
        ? { questions: ["What database should this use?", "Multi-tenant?"] }
        : { question: "Which database?", options: ["Postgres", "SQLite"] },
  });

  const result = await registerAndAsk(recordHome, "build an app", { project, brain });

  assert.deepEqual(result.questions, ["Which database?"]);
  assert.equal(brain.askCalls.length, 2);
  assert.match(brain.askCalls[1], /rejected: .*2 free-form questions/);

  const events = readEventsForTask(recordHome, result.taskId);
  assert.deepEqual(
    events.map((e) => e.name),
    // One cost per ask call - a re-asked pass is not a free pass through
    // rule 10's ledger.
    ["task-received", "ask-cost-recorded", "ask-rejected", "ask-cost-recorded", "questions-asked"]
  );
  const rejected = events.find((e) => e.name === "ask-rejected")!.details as AskRejectedDetails;
  assert.equal(rejected.call, 1);
  assert.equal(rejected.reasksLeft, 2);
  assert.match(rejected.problem, /free-form/);
});

test("registerAndAsk rejects a question with too few options, and one with an 'other' of its own", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  const brain = fakeBrain({
    askQuestion: (call) =>
      call === 1
        ? { question: "Which database?", options: ["Postgres"] }
        : call === 2
          ? { question: "Which database?", options: ["Postgres", "SQLite", OTHER_OPTION] }
          : { question: "Which database?", options: ["Postgres", "SQLite"] },
  });

  const result = await registerAndAsk(recordHome, "build an app", { project, brain });

  assert.deepEqual(result.questions, ["Which database?"]);
  const problems = readEventsForTask(recordHome, result.taskId)
    .filter((e) => e.name === "ask-rejected")
    .map((e) => (e.details as AskRejectedDetails).problem);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /needs 2 to 4 options, got 1/);
  assert.match(problems[1], /leave "other" out/);
});

// "Everything fails loudly. A silent skip is a bug": three tries at one
// fixed shape is not a formatting slip to proceed past.
test("registerAndAsk fails the task after two rejected re-asks, and says so on the record", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  const brain = fakeBrain({ askQuestion: { question: "Which database?", options: ["Postgres"] } });

  await assert.rejects(
    () => registerAndAsk(recordHome, "build an app", { project, brain }),
    (err: unknown) => err instanceof ForemanError && err.code === "ask-shape-invalid"
  );

  assert.equal(brain.askCalls.length, 3, "the first call plus two re-asks, and no more");
  const [taskId] = readdirSync(join(recordHome, "tasks"));
  const events = readEventsForTask(recordHome, taskId);
  assert.deepEqual(
    events.map((e) => e.name),
    [
      "task-received",
      "ask-cost-recorded",
      "ask-rejected",
      "ask-cost-recorded",
      "ask-rejected",
      "ask-cost-recorded",
      "ask-rejected",
      // Fabrica's own refusal, not the brain's - "ask-failed" is
      // reserved for `brain.ask()` itself throwing, and this one
      // answered, it just never used the shape.
      "task-failed",
    ]
  );
  assert.equal((events.at(-2)!.details as AskRejectedDetails).reasksLeft, 0);
  assert.match((events.at(-1)!.details as { message: string }).message, /asked 3 times and never used the required shape/);
});

// Issue #175, the guard every ask goes through: a question whose id this
// task already answered is answered from the record, not put to the
// Client a second time. Driven directly, because a Fabrica task asks
// once - on its first pass, where there is nothing answered yet (see
// `autoAnswerFromRecord`'s own note on where this fires).
test("a question the record already has an answer for is answered from it, and the reuse is recorded", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  const brain = fakeBrain({ askQuestion: { question: "Which database?", options: ["Postgres", "SQLite"] } });

  const asked = await registerAndAsk(recordHome, "build an app", { project, brain });
  const question = asked.question!;
  // The Client picks an option, the ordinary way.
  recordAnswerDecision(recordHome, asked.taskId, "", { option: 1 });

  // The same question - same text, same options, so the same derived
  // id - comes back on a later round of the SAME task, which is the
  // whole scope of "the first answer wins".
  const auto = autoAnswerFromRecord(recordHome, asked.taskId, question);

  assert.equal(auto?.answer, "Postgres");
  assert.match(auto!.brief, /Postgres/);
  assert.match(readTaskFile(recordHome, asked.taskId, "brief.md") ?? "", /Postgres/);
  const reused = readEventsForTask(recordHome, asked.taskId)
    .filter((e) => e.name === "question-auto-answered")
    .map((e) => e.details as QuestionAutoAnsweredDetails);
  assert.equal(reused.length, 1);
  assert.equal(reused[0].questionId, question.id);
  assert.equal(reused[0].answer, "Postgres");
});

test("a question with no answer on the record is left for the Client, and records nothing", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  const brain = fakeBrain({ askQuestion: { question: "Which database?", options: ["Postgres", "SQLite"] } });

  const asked = await registerAndAsk(recordHome, "build an app", { project, brain });
  const before = readEventsForTask(recordHome, asked.taskId).length;

  assert.equal(autoAnswerFromRecord(recordHome, asked.taskId, asked.question!), null);
  assert.equal(readEventsForTask(recordHome, asked.taskId).length, before);
});

test("registerAndAsk records the exact attempts budget a later resume needs", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  const brain = fakeBrain({ askQuestion: { question: "Which?", options: ["This", "That"] } });

  const result = await registerAndAsk(recordHome, "build an app", { project, brain, attempts: 5 });

  const events = readEventsForTask(recordHome, result.taskId);
  const details = events.filter((e) => e.name === "questions-asked").at(-1)?.details as {
    totalAttempts: number;
    explicitAttempts: boolean;
  };
  assert.equal(details.totalAttempts, 5);
  assert.equal(details.explicitAttempts, true);
});

test("registerAndAsk rejects when no brain is provided, before registering anything", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");

  await assert.rejects(
    () => registerAndAsk(recordHome, "small change", { project }),
    (err: unknown) => err instanceof ForemanError && err.code === "no-brain"
  );
});

test("registerAndAsk rejects a non-positive-integer attempts count", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");

  await assert.rejects(
    () => registerAndAsk(recordHome, "small change", { project, brain: fakeBrain(), attempts: 0 }),
    (err: unknown) => err instanceof ForemanError && err.code === "invalid-attempts"
  );
});

// A task must never look started when its very first step never ran
// (Client ruling, issue #8 follow-up) - if brain.ask() itself throws
// (the reference adapter's documented credential gap is today's live
// path), the record must say so, not stay silent at "task-received"
// forever.
test("registerAndAsk records ask-failed with the real error, and still rethrows, when brain.ask() throws", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  const brain = fakeBrain({ askError: new Error("simulated: the brain is unreachable") });

  await assert.rejects(
    () => registerAndAsk(recordHome, "build an app", { project, brain }),
    /simulated: the brain is unreachable/
  );

  // The task was still registered - registerTask runs before ask() ever
  // does - so its record folder and taskId exist even though this call
  // never returns one; find it back the same way a fresh watcher would.
  const [taskId] = readdirSync(join(recordHome, "tasks"));

  const events = readEventsForTask(recordHome, taskId);
  assert.deepEqual(
    events.map((e) => e.name),
    ["task-received", "ask-failed"]
  );
  const details = events[1].details as { error: string };
  assert.equal(details.error, "simulated: the brain is unreachable");
});
