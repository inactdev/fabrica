// #73, Client ruling 2026-10-10 ("a failed start is never silent"): any
// error after task-received and before a delivery or refusal appends a
// "task-failed" event carrying the message, so the record - and every
// reader of it - says the task failed, instead of it sitting at "working".
// Also (d): a project path that is missing or not a git root is refused
// before the clarifying step spends anything.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "./foreman.ts";
import { stateOf } from "./queries.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { fakeInspector } from "../../contract/helpers/fake-inspector.ts";
import { fakeCheckBox } from "../../contract/helpers/fake-check-box.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { readEvents } from "../record/index.ts";
import type { Brain } from "../brain/index.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-task-failed-home-"));
}

function eventsOfOnlyTask(recordHome: string) {
  const events = readEvents(recordHome);
  return events.filter((e) => e.taskId === events[0].taskId);
}

function failedDetails(recordHome: string): { message?: string } | undefined {
  return eventsOfOnlyTask(recordHome).find((e) => e.name === "task-failed")?.details as { message?: string } | undefined;
}

test("an error after task-received, before delivery, appends task-failed with the message, and the task reads as failed", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0", { inspector: false });
  rmSync(join(project, "check.sh"));
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "no check"], { cwd: project });
  const foreman = createForeman({ recordHome, checkBox: fakeCheckBox().box });

  await assert.rejects(() => foreman.do("small change", { project, brain: fakeBrain() }), /check\.sh/);

  assert.match(failedDetails(recordHome)?.message ?? "", /check\.sh/, "no task-failed event carrying the message");
  assert.equal(stateOf(eventsOfOnlyTask(recordHome)), "failed");
});

test("a worker that throws mid-round leaves task-failed on the record, not a task stuck at working", async () => {
  const recordHome = freshHome();
  const brain: Brain = {
    name: "throwing",
    model: "throwing-1",
    async ask() {
      return {};
    },
    async work() {
      throw new Error("the container died");
    },
  };
  const foreman = createForeman({ recordHome, inspector: fakeInspector("green") });

  await assert.rejects(() => foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain }), /container died/);

  assert.match(failedDetails(recordHome)?.message ?? "", /the container died/);
  assert.equal(stateOf(eventsOfOnlyTask(recordHome)), "failed");
});

test("an answered round that throws appends task-failed too", async () => {
  const recordHome = freshHome();
  let asked = false;
  const brain: Brain = {
    name: "asks-then-throws",
    model: "x",
    async ask() {
      asked = true;
      return { questions: ["Which database?"] };
    },
    async work() {
      throw new Error("worker unreachable on resume");
    },
  };
  const foreman = createForeman({ recordHome, inspector: fakeInspector("green") });
  const task = await foreman.do("build me an app", { project: makeFixtureRepo("exit 0"), brain });
  assert.ok(asked);

  await assert.rejects(() => foreman.answer(task.id, "Use Postgres."), /worker unreachable on resume/);

  assert.match(failedDetails(recordHome)?.message ?? "", /worker unreachable on resume/);
});

test("a failure the record already names (ask-failed, cap-refused) is not recorded a second time as task-failed", async () => {
  const askHome = freshHome();
  const askFails = createForeman({ recordHome: askHome, inspector: fakeInspector("green") });
  await assert.rejects(() =>
    askFails.do("small change", { project: makeFixtureRepo("exit 0"), brain: fakeBrain({ askError: new Error("unreachable") }) })
  );
  assert.ok(eventsOfOnlyTask(askHome).some((e) => e.name === "ask-failed"));
  assert.ok(!eventsOfOnlyTask(askHome).some((e) => e.name === "task-failed"));

  const capHome = freshHome();
  const capped = createForeman({ recordHome: capHome, caps: { perDayUsd: 0 }, inspector: fakeInspector("green") });
  await assert.rejects(() => capped.do("small change", { project: makeFixtureRepo("exit 0"), brain: fakeBrain() }));
  assert.ok(eventsOfOnlyTask(capHome).some((e) => e.name === "cap-refused"));
  assert.ok(!eventsOfOnlyTask(capHome).some((e) => e.name === "task-failed"));
});

for (const [label, makeProject] of [
  ["does not exist", () => join(mkdtempSync(join(tmpdir(), "fabrica-gone-")), "no-such-project")],
  ["is not a git root", () => mkdtempSync(join(tmpdir(), "fabrica-not-git-"))],
  [
    "is a folder inside a repository, not its root",
    () => {
      const repo = makeFixtureRepo("exit 0");
      const sub = join(repo, "sub");
      execFileSync("mkdir", [sub]);
      return sub;
    },
  ],
] as const) {
  test(`a project path that ${label} is refused before the clarifying step spends anything`, async () => {
    const recordHome = freshHome();
    const brain = fakeBrain();
    const foreman = createForeman({ recordHome, inspector: fakeInspector("green") });
    const project = makeProject();

    await assert.rejects(() => foreman.do("small change", { project, brain }), (err: Error) => err.message.includes(project));

    assert.equal(brain.askCalls.length, 0, "the clarifying step ran against a project that is not a git root");
    assert.equal(brain.calls, 0);
    assert.ok(failedDetails(recordHome)?.message?.includes(project), "the refusal is not on the record");
  });
}
