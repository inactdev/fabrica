import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doTask, runProductionRound } from "./do.ts";
import { ForemanError } from "./errors.ts";
import { deliveryOf, receiptsOf } from "./queries.ts";
import { readEventsForTask, readTaskFile } from "../record/index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { LineError } from "../line/index.ts";
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

test("doTask on an undeclared gate change keeps the work on the ordinary branch, it does not discard it", async () => {
  const project = makeFixtureRepo("exit 1");
  const recordHome = freshHome();
  const brain = fakeBrain({
    onWork: (_brief, workdir) => {
      writeFileSync(join(workdir, "check.sh"), "#!/bin/sh\nexit 0\n");
      writeFileSync(join(workdir, "feature.txt"), "possibly good work\n");
    },
  });

  const task = await doTask(recordHome, "make it pass", { project, brain });

  const delivery = deliveryOf(recordHome, task.id);
  assert.equal(delivery?.outcome, "discarded-protected-path");
  const branch = `fabrica/${task.id}`;
  assert.equal(delivery?.branch, branch, "delivery.branch must stay the ordinary branch");
  assert.deepEqual(
    delivery?.files,
    ["check.sh", "feature.txt"],
    "the work must land on the branch, not come back empty"
  );

  const content = execSync(`git show ${branch}:feature.txt`, { cwd: project, encoding: "utf8" });
  assert.equal(content, "possibly good work\n", "the branch must carry the worker's real content");
});

test("doTask keeps the work on the ordinary branch on an undeclared gate change even when the worker commits it itself", async () => {
  const project = makeFixtureRepo("exit 1");
  const recordHome = freshHome();
  const brain = fakeBrain({
    onWork: (_brief, workdir) => {
      writeFileSync(join(workdir, "check.sh"), "#!/bin/sh\nexit 0\n");
      writeFileSync(join(workdir, "feature.txt"), "committed by the worker\n");
      execSync("git add -A && git -c user.email=w@w -c user.name=w commit -qm worker-commit", {
        cwd: workdir,
        shell: "/bin/bash",
      });
    },
  });

  const task = await doTask(recordHome, "make it pass", { project, brain });

  const delivery = deliveryOf(recordHome, task.id);
  assert.equal(delivery?.outcome, "discarded-protected-path");
  const branch = `fabrica/${task.id}`;
  assert.equal(delivery?.branch, branch, "delivery.branch must stay the ordinary branch");
  assert.deepEqual(
    delivery?.files,
    ["check.sh", "feature.txt"],
    "the worker's own commit must still show up on the branch, not vanish"
  );

  const content = execSync(`git show ${branch}:feature.txt`, { cwd: project, encoding: "utf8" });
  assert.equal(content, "committed by the worker\n", "the branch must carry the worker's real content");
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

// A commit failure used to propagate straight out of doTask: `finally`
// still force-removed the worktree, destroying the Worker's uncommitted
// work, and nothing was ever written to the record - a task vanishing
// without a trace. Client ruling (option A, commit-failure-loses-work-
// and-record): the record must always say what happened.
test("doTask records an honest failure-report, not silence, when the pre-teardown commit itself fails", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();
  const brain = fakeBrain({
    onWork: (_brief, workdir) => {
      writeFileSync(join(workdir, "feature.txt"), "good work\n");
      // A stale index.lock is a real-world case: a Worker's own git
      // process left one behind. --git-path resolves the correct lock
      // for a linked worktree, not the main repo's own .git/index.lock.
      const lockPath = execSync("git rev-parse --git-path index.lock", { cwd: workdir, encoding: "utf8" }).trim();
      writeFileSync(lockPath, "");
    },
  });

  const task = await doTask(recordHome, "make it pass", { project, brain });

  assert.equal(task.state, "failed");

  const delivery = deliveryOf(recordHome, task.id);
  assert.equal(delivery?.outcome, "failure-report");
  assert.deepEqual(delivery?.files, [], "a failed commit means nothing landed on the branch");
  assert.match(delivery?.gaps ?? "", /could not commit/);
  assert.match(delivery?.gaps ?? "", /index\.lock/);

  const receipts = receiptsOf(recordHome, task.id);
  assert.equal(receipts[receipts.length - 1].outcome, "failed");
});

// Issue #8's own definition of done, scenario 1: a materially ambiguous
// task returns numbered questions and starts no worker.
test("doTask stops and returns 'asking' when the brain finds the task materially ambiguous, without starting a worker", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();
  const brain = fakeBrain({ askQuestions: ["What database should this use?", "Multi-tenant?"] });

  const task = await doTask(recordHome, "build me an app", { project, brain });

  assert.equal(task.state, "asking");
  assert.equal(brain.calls, 0, "no worker should run before the Client answers");

  const events = readEventsForTask(recordHome, task.id);
  assert.deepEqual(
    events.map((e) => e.name),
    ["task-received", "questions-asked"]
  );

  // No ProductionLine was ever cut - rule 1 holds trivially since there
  // was never anything to isolate in the first place.
  const worktrees = execSync("git worktree list", { cwd: project, encoding: "utf8" });
  assert.equal(worktrees.trim().split("\n").length, 1, "only the main worktree should exist");

  // No delivery exists yet for an asking task.
  assert.equal(deliveryOf(recordHome, task.id), null);
});

// Issue #8's own definition of done, scenario 3: an unambiguous task is
// unaffected and runs exactly as it did before this issue - the brain is
// still consulted (ask() is called once), but nothing about the outcome
// changes.
test("doTask on an unambiguous task is unaffected: ask() is consulted but the task runs exactly as before", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();
  const brain = fakeBrain(); // no askQuestions configured - nothing to ask

  const task = await doTask(recordHome, "small change", { project, brain });

  assert.equal(task.state, "delivered");
  assert.deepEqual(brain.askCalls, ["small change"], "the brain's first pass still runs");
  assert.equal(brain.calls, 1, "exactly one work() call, same as before issue #8");

  const events = readEventsForTask(recordHome, task.id);
  assert.deepEqual(
    events.map((e) => e.name),
    ["task-received", "line-cut", "work-started", "check-run", "delivered"],
    "no questions-asked/answers-given events for a task nothing needed to ask about"
  );

  const delivery = deliveryOf(recordHome, task.id);
  assert.equal(delivery?.outcome, "done");
});

// Client ruling: runProductionRound's create-vs-reopen choice must come
// from an explicit isRetry the caller derives from the record - not from
// whether a same-named branch happens to exist in the project - because
// a taskId is only unique within one record home, while branches live in
// the project. A foreign or leftover fabrica/<taskId> branch (a
// different record home's task, a hand-made branch, a record home
// recreated while the project's own branches survived) must never be
// silently adopted just because it shares a name.
test("runProductionRound on a first-ever round (isRetry: false) refuses loudly even if a same-named branch already exists", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();
  const taskId = "not-actually-a-retry";
  // A branch that has nothing to do with this call - standing in for a
  // foreign/leftover branch that merely happens to share this taskId.
  execSync(`git branch fabrica/${taskId}`, { cwd: project, shell: "/bin/bash" });

  await assert.rejects(
    () =>
      runProductionRound(recordHome, taskId, "some brief", {
        project,
        brain: fakeBrain(),
        totalAttempts: 2,
        explicitAttempts: false,
        isRetry: false,
      }),
    (err: unknown) => err instanceof LineError && err.code === "cut-failed"
  );
});

test("runProductionRound with isRetry: true reopens the task's own branch", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();
  const taskId = "a-genuine-retry";

  // First round: a real createProductionLine call, as doTask's own
  // first-ever call would make - leaves the branch behind once torn down.
  const first = await runProductionRound(recordHome, taskId, "some brief", {
    project,
    brain: fakeBrain(),
    totalAttempts: 1,
    explicitAttempts: true,
    isRetry: false,
  });
  assert.equal(first.state, "delivered");

  // Second round for the SAME taskId, declared a retry - must reopen the
  // branch the first round already cut, not refuse on "already exists".
  const second = await runProductionRound(recordHome, taskId, "some brief, retried", {
    project,
    brain: fakeBrain(),
    totalAttempts: 1,
    explicitAttempts: true,
    isRetry: true,
  });
  assert.equal(second.state, "delivered");
});
