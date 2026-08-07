import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAndAsk } from "./ask.ts";
import { ForemanError } from "./errors.ts";
import { readEventsForTask, readTaskFile } from "../record/index.ts";
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

test("registerAndAsk returns the questions and records them, when the brain has something to ask", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  const brain = fakeBrain({ askQuestions: ["What database should this use?", "Multi-tenant?"] });

  const result = await registerAndAsk(recordHome, "build an app", { project, brain });

  assert.deepEqual(result.questions, ["What database should this use?", "Multi-tenant?"]);

  const events = readEventsForTask(recordHome, result.taskId);
  assert.deepEqual(
    events.map((e) => e.name),
    ["task-received", "questions-asked"]
  );
  const details = events[1].details as {
    questions: string[];
    project: string;
    totalAttempts: number;
    explicitAttempts: boolean;
  };
  assert.deepEqual(details.questions, ["What database should this use?", "Multi-tenant?"]);
  assert.equal(details.project, project);
  assert.equal(details.totalAttempts, 2);
  assert.equal(details.explicitAttempts, false);
});

test("registerAndAsk filters out blank questions", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  const brain = fakeBrain({ askQuestions: ["Real question?", "   ", ""] });

  const result = await registerAndAsk(recordHome, "build an app", { project, brain });

  assert.deepEqual(result.questions, ["Real question?"]);
});

test("registerAndAsk records the exact attempts budget a later resume needs", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  const brain = fakeBrain({ askQuestions: ["Which?"] });

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
