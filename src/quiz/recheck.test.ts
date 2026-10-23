// The cheap worker round: one brain call per task with outdated
// questions, in a throwaway checkout of current master, answering by
// writing a JSON file the host then reads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent, readEvents, registerTask } from "../record/index.ts";
import { daySpend, taskSpend } from "../foreman/index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureProject } from "../line/helpers/fixture.ts";

import { fakeDelivery, quizRecordHome, threeQuestions, writeupWithQuiz } from "./helpers/fixture.ts";
import { appendQuizStale } from "./events.ts";
import { quizQuestionsForTask } from "./questions.ts";
import { parseRecheckVerdicts, recheckBrief, recheckRoomProblem, runQuizRecheck } from "./recheck.ts";
import { allQuizQuestions } from "./review.ts";

/** An accepted task on a real git project, so a re-check can actually
 * cut a checkout of it. */
function acceptedOnProject(recordHome: string, project: string, title: string, files: string[]): string {
  const { id } = registerTask(recordHome, title);
  appendEvent(recordHome, { taskId: id, name: "work-started", details: { project } });
  appendEvent(recordHome, {
    taskId: id,
    name: "delivered",
    details: { outcome: "done", writeup: writeupWithQuiz(title, threeQuestions(title)), delivery: fakeDelivery(files) },
  });
  appendEvent(recordHome, { taskId: id, name: "verdict-recorded", details: { ruling: "accept" } });
  return id;
}

function statusesOf(recordHome: string, taskId: string): string[] {
  return allQuizQuestions(recordHome)
    .filter((question) => question.taskId === taskId)
    .map((question) => question.status);
}

test("nothing outdated means nothing runs and no brain is called", async () => {
  const recordHome = quizRecordHome();
  const project = makeFixtureProject();
  acceptedOnProject(recordHome, project, "Ship it", ["a.ts"]);
  const brain = fakeBrain();

  const run = await runQuizRecheck(recordHome, { brain });
  assert.match(run.skipped ?? "", /no quiz question is marked outdated/);
  assert.equal(brain.calls, 0);
});

test("one worker call per task rules on every outdated question it carries, and clears them", async () => {
  const recordHome = quizRecordHome();
  const project = makeFixtureProject();
  const id = acceptedOnProject(recordHome, project, "Ship it", ["a.ts"]);
  appendQuizStale(recordHome, id, { touchedBy: "20261022-later-aa", files: ["a.ts"] });

  const briefs: string[] = [];
  const brain = fakeBrain({
    costUsd: 0.25,
    onWork: (brief, workdir) => {
      briefs.push(brief);
      writeFileSync(
        join(workdir, "quiz-recheck.json"),
        JSON.stringify({
          verdicts: [
            { index: 0, outcome: "confirmed", note: "still true" },
            { index: 1, outcome: "rewritten", question: "New question?", answer: "New answer.", note: "moved" },
            { index: 2, outcome: "retired", note: "that code is gone" },
          ],
        })
      );
    },
  });

  const run = await runQuizRecheck(recordHome, { brain });
  assert.equal(run.skipped, undefined);
  assert.equal(brain.calls, 1, "one call for the task, not one per question");
  assert.equal(run.deferred, 0);
  assert.match(run.notes[0], /#0 confirmed, #1 rewritten, #2 retired/);

  const questions = allQuizQuestions(recordHome).filter((question) => question.taskId === id);
  assert.deepEqual(
    questions.map((question) => question.status),
    ["live", "live", "retired"]
  );
  assert.equal(questions[1].question, "New question?");
  assert.equal(questions[1].rewritten, true);

  // The brief told the worker where it was, which questions to rule on,
  // and what dated them.
  assert.match(briefs[0], /throwaway checkout/);
  assert.match(briefs[0], /\[index 0\]/);
  assert.match(briefs[0], /20261022-later-aa/);
  assert.match(briefs[0], /quiz-recheck\.json/);
});

test("the round's cost lands on the record against the task it re-checked, and in the day's spend", async () => {
  const recordHome = quizRecordHome();
  const project = makeFixtureProject();
  const id = acceptedOnProject(recordHome, project, "Ship it", ["a.ts"]);
  appendQuizStale(recordHome, id, { touchedBy: "later", files: ["a.ts"] });
  const brain = fakeBrain({
    costUsd: 0.25,
    onWork: (_brief, workdir) =>
      writeFileSync(join(workdir, "quiz-recheck.json"), JSON.stringify({ verdicts: [{ index: 0, outcome: "confirmed" }] })),
  });

  await runQuizRecheck(recordHome, { brain });

  const events = readEvents(recordHome);
  const costEvents = events.filter((event) => event.name === "quiz-recheck-cost-recorded");
  assert.equal(costEvents.length, 1);
  assert.equal(costEvents[0].taskId, id);
  assert.equal((costEvents[0].details as { costUsd: number }).costUsd, 0.25);
  assert.equal(taskSpend(events, id).meteredUsd, 0.25);
  assert.equal(daySpend(events, Date.now()).meteredUsd, 0.25);
});

test("a second re-check of the same task is its own ledger entry, not an overwrite of the first", async () => {
  const recordHome = quizRecordHome();
  const project = makeFixtureProject();
  const id = acceptedOnProject(recordHome, project, "Ship it", ["a.ts"]);
  const brain = fakeBrain({
    costUsd: 0.1,
    onWork: (_brief, workdir) =>
      writeFileSync(
        join(workdir, "quiz-recheck.json"),
        JSON.stringify({
          verdicts: [0, 1, 2].map((index) => ({ index, outcome: "confirmed" })),
        })
      ),
  });

  appendQuizStale(recordHome, id, { touchedBy: "first", files: ["a.ts"] });
  await runQuizRecheck(recordHome, { brain });
  appendQuizStale(recordHome, id, { touchedBy: "second", files: ["a.ts"] });
  await runQuizRecheck(recordHome, { brain });

  assert.equal(brain.calls, 2);
  assert.equal(taskSpend(readEvents(recordHome), id).meteredUsd, 0.2);
});

test("a worker that writes nothing readable leaves its questions outdated, and says so", async () => {
  const recordHome = quizRecordHome();
  const project = makeFixtureProject();
  const id = acceptedOnProject(recordHome, project, "Ship it", ["a.ts"]);
  appendQuizStale(recordHome, id, { touchedBy: "later", files: ["a.ts"] });

  const silent = fakeBrain({ costUsd: 0.01 });
  const run = await runQuizRecheck(recordHome, { brain: silent });
  assert.match(run.notes[0], /wrote no quiz-recheck\.json, left outdated/);
  assert.deepEqual(statusesOf(recordHome, id), ["outdated", "outdated", "outdated"]);

  // Garbage is the same outcome - and still only leaves them outdated,
  // which is the safe direction: an outdated question is never asked.
  const garbage = fakeBrain({
    costUsd: 0.01,
    onWork: (_brief, workdir) => writeFileSync(join(workdir, "quiz-recheck.json"), "not json at all"),
  });
  const second = await runQuizRecheck(recordHome, { brain: garbage });
  assert.match(second.notes[0], /nothing usable/);
  assert.deepEqual(statusesOf(recordHome, id), ["outdated", "outdated", "outdated"]);
});

test("a task whose project the record never named is skipped rather than throwing", async () => {
  const recordHome = quizRecordHome();
  const { id } = registerTask(recordHome, "No project");
  appendEvent(recordHome, {
    taskId: id,
    name: "delivered",
    details: { outcome: "done", writeup: writeupWithQuiz("No project", threeQuestions("x")), delivery: fakeDelivery(["a.ts"]) },
  });
  appendEvent(recordHome, { taskId: id, name: "verdict-recorded", details: { ruling: "accept" } });
  appendQuizStale(recordHome, id, { touchedBy: "later", files: ["a.ts"] });

  const brain = fakeBrain();
  const run = await runQuizRecheck(recordHome, { brain });
  assert.match(run.notes[0], /no project on the record, left outdated/);
  assert.equal(brain.calls, 0);
});

test("a run is bounded, oldest acceptance first, and says what it left for next time", async () => {
  const recordHome = quizRecordHome();
  const project = makeFixtureProject();
  const ids = [1, 2, 3].map((n) => acceptedOnProject(recordHome, project, `Task ${n}`, ["a.ts"]));
  for (const id of ids) appendQuizStale(recordHome, id, { touchedBy: "later", files: ["a.ts"] });

  const brain = fakeBrain({
    costUsd: 0.01,
    onWork: (_brief, workdir) =>
      writeFileSync(join(workdir, "quiz-recheck.json"), JSON.stringify({ verdicts: [{ index: 0, outcome: "confirmed" }] })),
  });

  const run = await runQuizRecheck(recordHome, { brain, maxTasks: 2 });
  assert.equal(brain.calls, 2);
  assert.equal(run.deferred, 1);
  assert.equal(run.notes.length, 2);
  // Oldest acceptance first: the third task is the one left waiting.
  assert.deepEqual(statusesOf(recordHome, ids[2]), ["outdated", "outdated", "outdated"]);
});

test("every checkout a run cut is removed again, whatever the worker did", async () => {
  const recordHome = quizRecordHome();
  const project = makeFixtureProject();
  const id = acceptedOnProject(recordHome, project, "Ship it", ["a.ts"]);
  appendQuizStale(recordHome, id, { touchedBy: "later", files: ["a.ts"] });

  const thrower = fakeBrain({
    onWork: () => {
      throw new Error("the worker fell over");
    },
  });
  const run = await runQuizRecheck(recordHome, { brain: thrower });
  assert.match(run.notes[0], /re-check failed \(the worker fell over\), left outdated/);
  assert.deepEqual(statusesOf(recordHome, id), ["outdated", "outdated", "outdated"]);
  // Nothing is left behind under the record home's scratch folder.
  const scratch = join(recordHome, "scratch");
  if (existsSync(scratch)) {
    for (const entry of readdirSync(scratch)) {
      assert.ok(!existsSync(join(scratch, entry, "worktree")), `${entry}'s checkout was not removed`);
    }
  }
});

test("a cap with no room left stops the run before any money is spent", async () => {
  const recordHome = quizRecordHome();
  const project = makeFixtureProject();
  const id = acceptedOnProject(recordHome, project, "Ship it", ["a.ts"]);
  appendQuizStale(recordHome, id, { touchedBy: "later", files: ["a.ts"] });
  appendEvent(recordHome, {
    taskId: id,
    name: "receipt-recorded",
    details: {
      receipt: {
        task: id,
        attempt: 1,
        brain: "fake",
        model: "fake-1",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        costUsd: 9,
        costBasis: "metered",
        outcome: "delivered",
        meters: null,
      },
    },
  });

  const brain = fakeBrain();
  const run = await runQuizRecheck(recordHome, { brain, caps: { perDayUsd: 5 } });
  assert.match(run.skipped ?? "", /daily cap is reached/);
  assert.equal(brain.calls, 0);
  // And a cap refusal must never land on an already-closed task's record
  // as a "cap-refused" start it never attempted.
  assert.equal(readEvents(recordHome).filter((event) => event.name === "cap-refused").length, 0);
});

test("the pause rule holds a re-check back too - a free-looking round must not drain the week's quota", async () => {
  const recordHome = quizRecordHome();
  const project = makeFixtureProject();
  const id = acceptedOnProject(recordHome, project, "Ship it", ["a.ts"]);
  appendQuizStale(recordHome, id, { touchedBy: "later", files: ["a.ts"] });
  appendEvent(recordHome, {
    taskId: id,
    name: "receipt-recorded",
    details: {
      receipt: {
        task: id,
        attempt: 1,
        brain: "fake",
        model: "fake-1",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        costUsd: 0,
        costBasis: "subscription-estimate",
        outcome: "delivered",
        meters: { observedAt: new Date().toISOString(), fiveHourPercent: 10, sevenDayPercent: 99 },
      },
    },
  });
  writeFileSync(join(recordHome, "projects.toml"), "[pause]\nsevenDayRefusePercent = 70\n");

  const brain = fakeBrain();
  const run = await runQuizRecheck(recordHome, { brain });
  assert.match(run.skipped ?? "", /the pause rule is holding new work back/);
  assert.equal(brain.calls, 0);
  // And, like the cap refusal, it leaves no refusal event on a task that
  // never attempted a start.
  assert.equal(readEvents(recordHome).filter((event) => event.name === "meter-refused").length, 0);
});

test("recheckRoomProblem: no cap set is always room, and unmeasured spend blocks under one", () => {
  const unmeasured = [
    {
      taskId: "t",
      name: "receipt-recorded" as const,
      occurredAt: new Date().toISOString(),
      details: {
        receipt: {
          task: "t",
          attempt: 1,
          brain: "fake",
          model: "fake-1",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          costUsd: null,
          outcome: "delivered",
        },
      },
    },
  ] as unknown as Parameters<typeof recheckRoomProblem>[0];

  assert.equal(recheckRoomProblem(unmeasured, undefined, Date.now()), null);
  assert.match(recheckRoomProblem(unmeasured, { perDayUsd: 100 }, Date.now()) ?? "", /never measured/);
});

test("parseRecheckVerdicts keeps only what was asked about and only what is usable", () => {
  const asked = [0, 1, 2];
  assert.deepEqual(parseRecheckVerdicts("not json", asked), []);
  assert.deepEqual(parseRecheckVerdicts("{}", asked), []);
  assert.deepEqual(
    parseRecheckVerdicts(
      JSON.stringify({
        verdicts: [
          { index: 0, outcome: "confirmed", note: "  fine  " },
          { index: 0, outcome: "retired" },
          { index: 5, outcome: "confirmed" },
          { index: 1, outcome: "shrugged" },
          { index: 1, outcome: "rewritten", question: "  ", answer: "x" },
          { index: 2, outcome: "rewritten", question: " Q? ", answer: " A. " },
          "nonsense",
        ],
      }),
      asked
    ),
    [
      { index: 0, outcome: "confirmed", note: "fine" },
      { index: 2, outcome: "rewritten", question: "Q?", answer: "A." },
    ]
  );
});

test("recheckBrief names the three outcomes it will accept, and never asks for a change to the project", () => {
  const recordHome = quizRecordHome();
  const project = makeFixtureProject();
  const id = acceptedOnProject(recordHome, project, "Ship it", ["a.ts"]);
  appendQuizStale(recordHome, id, { touchedBy: "20261022-later-aa", files: ["a.ts"] });

  const brief = recheckBrief({
    project,
    base: "origin/master",
    baseCommit: "abc123",
    taskId: id,
    taskTitle: "Ship it",
    acceptedAt: "2026-10-22",
    questions: quizQuestionsForTask(id, readEvents(recordHome).filter((event) => event.taskId === id), Date.now()),
  });

  for (const outcome of ["confirmed", "rewritten", "retired"]) assert.match(brief, new RegExp(`"${outcome}"`));
  assert.match(brief, /You are not changing the project/);
  assert.match(brief, /change nothing else/);
  assert.match(brief, /abc123/);
});

// Issue #199: a re-check's own model call is as droppable as a worker's.
// It gets the same single retry on the same model, recorded against the
// task whose questions were being re-checked - so a blip costs the run
// nothing, and the record still says a reconnect happened.
test("a re-check whose model call is dropped is retried once, recorded, and still lands its verdicts", async () => {
  const recordHome = quizRecordHome();
  const project = makeFixtureProject();
  const id = acceptedOnProject(recordHome, project, "Ship it", ["a.ts"]);
  appendQuizStale(recordHome, id, { touchedBy: "later", files: ["a.ts"] });
  const brain = fakeBrain({
    workError: (call) => (call === 1 ? new Error("Connection closed mid-response") : undefined),
    onWork: (_brief, workdir) =>
      writeFileSync(join(workdir, "quiz-recheck.json"), JSON.stringify({ verdicts: [{ index: 0, outcome: "confirmed" }] })),
  });

  await runQuizRecheck(recordHome, { brain });

  const retries = readEvents(recordHome).filter((event) => event.name === "transport-retry");
  assert.equal(retries.length, 1);
  assert.equal(retries[0].taskId, id, "the retry is recorded against the task being re-checked");
  assert.equal(statusesOf(recordHome, id)[0], "live", "the retry's own answer was still used");
});
