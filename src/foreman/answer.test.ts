import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doTask } from "./do.ts";
import { answerTask } from "./answer.ts";
import { ForemanError } from "./errors.ts";
import { deliveryOf } from "./queries.ts";
import { readEventsForTask, readTaskFile } from "../record/index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import type { Brain } from "../brain/index.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-answer-home-"));
}

// Issue #8's own definition of done, scenario 2: answering a materially
// ambiguous task resumes it with the brief extended.
test("answerTask resumes an asking task, extends the brief, and delivers", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();
  const askBrain = fakeBrain({ askQuestions: ["What database should this use?"] });

  const asked = await doTask(recordHome, "build me an app", { project, brain: askBrain });
  assert.equal(asked.state, "asking");

  const workBrain = fakeBrain();
  const task = await answerTask(recordHome, asked.id, "Use Postgres.", { brain: workBrain });

  assert.equal(task.state, "delivered");
  assert.equal(workBrain.calls, 1);

  // The brief the worker actually received carries both the Client's
  // original words and the answer - a Worker never guesses silently.
  const briefSeen = workBrain.historyBySession.values().next().value?.[0];
  assert.match(briefSeen ?? "", /build me an app/);
  assert.match(briefSeen ?? "", /What database should this use\?/);
  assert.match(briefSeen ?? "", /Use Postgres\./);

  const brief = readTaskFile(recordHome, asked.id, "brief.md");
  assert.match(brief ?? "", /build me an app/);
  assert.match(brief ?? "", /Use Postgres\./);

  const request = readTaskFile(recordHome, asked.id, "request.md");
  assert.equal(request, "build me an app", "request.md stays verbatim, never appended to");

  const answers = readTaskFile(recordHome, asked.id, "answers.md");
  assert.match(answers ?? "", /What database should this use\?/);
  assert.match(answers ?? "", /Use Postgres\./);

  const events = readEventsForTask(recordHome, asked.id);
  assert.deepEqual(
    events.map((e) => e.name),
    ["task-received", "questions-asked", "answers-given", "work-started", "check-run", "delivered"]
  );

  const delivery = deliveryOf(recordHome, asked.id);
  assert.equal(delivery?.outcome, "done");
});

test("answerTask never calls ask() again - one clarification round by default", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();
  const askBrain = fakeBrain({ askQuestions: ["Which?"] });
  const asked = await doTask(recordHome, "build me an app", { project, brain: askBrain });

  const workBrain = fakeBrain({ askQuestions: ["Still ambiguous?"] });
  const task = await answerTask(recordHome, asked.id, "Whatever works.", { brain: workBrain });

  assert.equal(task.state, "delivered", "resuming must proceed to work, never ask again");
  assert.deepEqual(workBrain.askCalls, [], "the resumed round must not call ask() at all");
});

test("answerTask honors the original attempts budget from the do() call", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();
  const askBrain = fakeBrain({ askQuestions: ["Which?"] });
  const asked = await doTask(recordHome, "build me an app", { project, brain: askBrain, attempts: 3 });

  const workBrain = fakeBrain();
  await answerTask(recordHome, asked.id, "An answer.", { brain: workBrain });

  assert.equal(workBrain.calls, 3, "an explicit attempts count is honored on the resumed round too");
});

test("answerTask rejects an unknown task id", async () => {
  const recordHome = freshHome();

  await assert.rejects(
    () => answerTask(recordHome, "no-such-task", "an answer", { brain: fakeBrain() }),
    (err: unknown) => err instanceof ForemanError && err.code === "unknown-task"
  );
});

test("answerTask rejects a task that never asked a clarifying question", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();
  const task = await doTask(recordHome, "small change", { project, brain: fakeBrain() });

  await assert.rejects(
    () => answerTask(recordHome, task.id, "an answer", { brain: fakeBrain() }),
    (err: unknown) => err instanceof ForemanError && err.code === "no-questions-pending"
  );
});

test("answerTask rejects a second answer for the same task - the dial is fixed at one round", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();
  const askBrain = fakeBrain({ askQuestions: ["Which?"] });
  const asked = await doTask(recordHome, "build me an app", { project, brain: askBrain });
  await answerTask(recordHome, asked.id, "First answer.", { brain: fakeBrain() });

  await assert.rejects(
    () => answerTask(recordHome, asked.id, "Second answer.", { brain: fakeBrain() }),
    (err: unknown) => err instanceof ForemanError && err.code === "already-answered"
  );
});

// A resumed round can throw before ever reaching "delivered" - e.g. the
// brain itself is unreachable (docker down, a network blip) and work()
// rejects mid-attempt. The task must stay resumable rather than getting
// permanently stuck once "answers-given" is on the record with nothing
// to show for it: the ProductionLine's branch survives the failed
// attempt's own teardown (branches always outlive their worktree), so a
// second createProductionLine call for the same taskId would otherwise
// fail outright on "a branch named ... already exists" - the retry has
// to reopen that same branch instead.
test("answerTask allows a retry when the previous resume attempt threw before ever completing", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();
  const askBrain = fakeBrain({ askQuestions: ["Which?"] });
  const asked = await doTask(recordHome, "build me an app", { project, brain: askBrain });
  assert.equal(asked.state, "asking");

  const unreachableBrain: Brain = {
    name: "fake",
    model: "fake-1",
    async ask() {
      return {};
    },
    async work() {
      throw new Error("simulated: the brain is unreachable");
    },
  };

  await assert.rejects(
    () => answerTask(recordHome, asked.id, "First attempt.", { brain: unreachableBrain }),
    /simulated: the brain is unreachable/
  );

  // The Client fixes the underlying problem (here: the brain becomes
  // reachable again) and retries - this must not be refused as
  // already-answered, since the first attempt never delivered.
  const workBrain = fakeBrain();
  const task = await answerTask(recordHome, asked.id, "Second attempt.", { brain: workBrain });

  assert.equal(task.state, "delivered");
  assert.equal(workBrain.calls, 1);

  // Each `fabrica answer` call appends its own "answers-given" - the
  // retry is a second, real call, not a hidden replay, so the record
  // shows both attempts honestly (rule 5: nothing happens off the
  // books). The first attempt's own "work-started" is on the record too
  // - it genuinely started, it just never finished.
  const events = readEventsForTask(recordHome, asked.id).map((e) => e.name);
  assert.deepEqual(events, [
    "task-received",
    "questions-asked",
    "answers-given",
    "work-started",
    "answers-given",
    "work-started",
    "check-run",
    "delivered",
  ]);

  const answers = readTaskFile(recordHome, asked.id, "answers.md");
  assert.match(answers ?? "", /First attempt\./);
  assert.match(answers ?? "", /Second attempt\./);
});

test("answerTask rejects a blank answer", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();
  const askBrain = fakeBrain({ askQuestions: ["Which?"] });
  const asked = await doTask(recordHome, "build me an app", { project, brain: askBrain });

  await assert.rejects(
    () => answerTask(recordHome, asked.id, "   ", { brain: fakeBrain() }),
    (err: unknown) => err instanceof ForemanError && err.code === "missing-answer"
  );
});
