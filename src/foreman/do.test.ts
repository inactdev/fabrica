import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doTask } from "./do.ts";
import { ForemanError } from "./errors.ts";
import { deliveryOf, receiptsOf } from "./queries.ts";
import { readTaskFile } from "../record/index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-foreman-home-"));
}

test("doTask on a green project delivers after exactly one attempt", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();
  const brain = fakeBrain();

  const task = await doTask(recordHome, "small change", { project, brain });

  assert.equal(task.state, "delivered");
  assert.equal(brain.calls, 1);

  const delivery = deliveryOf(recordHome, task.id);
  assert.ok(delivery);
  assert.equal(delivery.outcome, "done");
  assert.equal(delivery.confidence, 100);
  assert.match(delivery.evidence, /check\.sh -> exit 0/);
  assert.equal(delivery.branch, `fabrica/${task.id}`);

  const receipts = receiptsOf(recordHome, task.id);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].outcome, "delivered");
  assert.equal(receipts[0].checks?.green, true);
  assert.equal(Object.hasOwn(receipts[0], "costUsd"), true);
});

test("doTask writes brief.md verbatim from the request, for every task", async () => {
  const recordHome = freshHome();
  const taskText = "small change, worth checking brief.md holds exactly this text";

  const delivered = await doTask(recordHome, taskText, {
    project: makeFixtureRepo("exit 0"),
    brain: fakeBrain(),
  });
  assert.equal(readTaskFile(recordHome, delivered.id, "brief.md"), taskText);

  // Verbatim regardless of how the task ends — a failed task is still
  // evidence of what a Worker was actually given.
  const failed = await doTask(recordHome, taskText, {
    project: makeFixtureRepo("exit 1"),
    brain: fakeBrain(),
  });
  assert.equal(failed.state, "failed");
  assert.equal(readTaskFile(recordHome, failed.id, "brief.md"), taskText);
});

test("doTask on an always-red project runs the default fix pass, then reports failure", async () => {
  const project = makeFixtureRepo("exit 1");
  const recordHome = freshHome();
  const brain = fakeBrain();

  const task = await doTask(recordHome, "any change", { project, brain });

  assert.equal(task.state, "failed");
  assert.equal(brain.calls, 2, "default policy: one attempt, one fix pass on red");

  const delivery = deliveryOf(recordHome, task.id);
  assert.ok(delivery);
  assert.equal(delivery.outcome, "failure-report");
  assert.equal(delivery.confidence, 0);

  const receipts = receiptsOf(recordHome, task.id);
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].outcome, "failed");
  assert.equal(receipts[1].outcome, "failed");

  // The retry is a correction into the same warm session, told exactly
  // what failed — never a cold restart (SPEC.md).
  const secondBrief = brain.historyBySession.get(receipts[1].session ?? "")?.[1];
  assert.ok(secondBrief);
  assert.match(secondBrief, /did not pass the project's check/);
  assert.match(secondBrief, /exit 1/);
});

test("doTask with explicit attempts runs exactly that many even once green", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();
  const brain = fakeBrain();

  const task = await doTask(recordHome, "counted attempts", { project, attempts: 4, brain });

  assert.equal(brain.calls, 4);

  // Every receipt's outcome reflects its own check result, so all four
  // green attempts read "delivered", not just the final one.
  const receipts = receiptsOf(recordHome, task.id);
  assert.deepEqual(
    receipts.map((r) => r.outcome),
    ["delivered", "delivered", "delivered", "delivered"]
  );
});

test("doTask refuses when the project has no check command at all", async () => {
  const project = mkdtempSync(join(tmpdir(), "fabrica-foreman-nocheck-"));
  writeFileSync(join(project, "app.txt"), "hello\n");
  const { execSync } = await import("node:child_process");
  execSync("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init", {
    cwd: project,
    shell: "/bin/bash",
  });
  const recordHome = freshHome();
  const brain = fakeBrain();

  await assert.rejects(
    () => doTask(recordHome, "do something", { project, brain }),
    (err: unknown) => err instanceof ForemanError && err.code === "missing-check"
  );

  assert.equal(brain.calls, 0, "no worker should run without a check command");
});

test("doTask honors a registered project's own check command over the check.sh convention", async () => {
  const project = makeFixtureRepo("exit 0");
  // This project's check.sh would fail; the registered command overrides it.
  writeFileSync(join(project, "check.sh"), "#!/bin/sh\nexit 1\n");
  const { execSync } = await import("node:child_process");
  execSync("git add -A && git -c user.email=t@t -c user.name=t commit -qm 'break check.sh'", {
    cwd: project,
    shell: "/bin/bash",
  });

  const recordHome = freshHome();
  writeFileSync(
    join(recordHome, "projects.toml"),
    `[projects.demo]\npath = "${project}"\ncheck = "echo custom-check-ran"\n`
  );
  const brain = fakeBrain();

  const task = await doTask(recordHome, "small change", { project, brain });

  assert.equal(task.state, "delivered");
  const delivery = deliveryOf(recordHome, task.id);
  assert.match(delivery?.evidence ?? "", /custom-check-ran/);
});

test("doTask destroys the ProductionLine's worktree even when the check command is missing", async () => {
  const project = mkdtempSync(join(tmpdir(), "fabrica-foreman-nocheck2-"));
  writeFileSync(join(project, "app.txt"), "hello\n");
  const { execSync } = await import("node:child_process");
  execSync("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init", {
    cwd: project,
    shell: "/bin/bash",
  });
  const recordHome = freshHome();

  await assert.rejects(() => doTask(recordHome, "do something", { project, brain: fakeBrain() }));

  const worktrees = execSync("git worktree list", { cwd: project, encoding: "utf8" });
  assert.equal(worktrees.trim().split("\n").length, 1, "only the main worktree should remain");
});

test("doTask rejects when no brain is provided", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();

  await assert.rejects(
    () => doTask(recordHome, "small change", { project }),
    (err: unknown) => err instanceof ForemanError && err.code === "no-brain"
  );
});

test("doTask records files touched by the worker in the delivery", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();
  const brain = fakeBrain({
    onWork: (_brief, workdir) => {
      writeFileSync(join(workdir, "app.txt"), "changed\n");
      writeFileSync(join(workdir, "new-file.txt"), "new\n");
    },
  });

  const task = await doTask(recordHome, "edit files", { project, brain });
  const delivery = deliveryOf(recordHome, task.id);

  assert.deepEqual([...(delivery?.files ?? [])].sort(), ["app.txt", "new-file.txt"]);
  // rule 1: none of this reached the Client's real checkout.
  assert.equal(readFileSync(join(project, "app.txt"), "utf8"), "hello from the fixture app\n");
});
