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
import { emitLiveTranscriptEntry } from "../brain/live-transcript.ts";
import type { Brain } from "../brain/index.ts";
import { LineError } from "../line/index.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { fixtureCheckBox } from "../../contract/helpers/fake-check-box.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-foreman-home-"));
}

// Negative first: nothing was declared in the worker's own write-up, so
// the commit's Deviations section says so plainly rather than leaving it
// blank or omitting it. (fakeBrain's default write-up, not rule 9's
// gateChanges declaration - see the next test for that distinction.)
test("the delivery commit's Deviations section says None when the worker's write-up declared no deviation", async () => {
  const project = makeFixtureRepo("exit 0", { inspector: false });
  const recordHome = freshHome();
  const brain = fakeBrain({ onWork: (_brief, workdir) => writeFileSync(join(workdir, "feature.txt"), "work\n") });

  const task = await doTask(recordHome, "small change", { project, brain, checkBox: fixtureCheckBox().box });

  const delivery = deliveryOf(recordHome, task.id);
  const message = execSync(`git log -1 --format=%B ${delivery!.branch}`, { cwd: project, encoding: "utf8" });
  assert.match(message, /Deviations:\nNone\./);
});

// rule 9's gateChanges declaration and the write-up's own Deviations
// section are two different things: gateChanges still lands on
// delivery.gateChanges for CI's rule-9 enforcement, but it is never what
// the commit's Deviations section shows any more - only the worker's own
// write-up is.
test("the delivery commit's Deviations section carries the worker's own write-up, not rule 9's gateChanges declaration", async () => {
  const project = makeFixtureRepo("exit 0", { inspector: false });
  const recordHome = freshHome();
  const brain = fakeBrain({
    onWork: (_brief, workdir) => writeFileSync(join(workdir, "feature.txt"), "work\n"),
    gateChanges: "widened check.sh's timeout because the suite grew",
    writeup: {
      title: "Widen the check timeout",
      what: "Widened check.sh's timeout.",
      why: "The suite grew.",
      how: "Bumped the sleep value.",
      deviations: "Widened check.sh's timeout because the suite grew.",
    },
  });

  const task = await doTask(recordHome, "small change", { project, brain, checkBox: fixtureCheckBox().box });

  const delivery = deliveryOf(recordHome, task.id);
  assert.equal(delivery?.gateChanges, "widened check.sh's timeout because the suite grew");
  const message = execSync(`git log -1 --format=%B ${delivery!.branch}`, { cwd: project, encoding: "utf8" });
  assert.match(message, /Deviations:\nWidened check\.sh's timeout because the suite grew\./);
});

// Negative first (pull requests must read like a human wrote them): a
// worker that returns an empty title is refused a "done" delivery -
// Fabrica names what's wrong rather than falling back to the task text.
test("a worker's write-up with an empty title is refused, not delivered as done", async () => {
  const project = makeFixtureRepo("exit 0", { inspector: false });
  const recordHome = freshHome();
  const brain = fakeBrain({
    onWork: (_brief, workdir) => writeFileSync(join(workdir, "feature.txt"), "work\n"),
    writeup: { title: "", what: "Did the work.", why: "Asked to.", how: "Directly.", deviations: "None." },
  });

  const task = await doTask(recordHome, "small change", {
    project,
    brain,
    checkBox: fixtureCheckBox().box,
    attempts: 1,
  });

  assert.equal(task.state, "failed");
  const delivery = deliveryOf(recordHome, task.id);
  assert.equal(delivery?.outcome, "failure-report");
  assert.match(delivery!.evidence, /write-up invalid: the title field is empty/);
});

test("a worker that returns no write-up is refused, not delivered as done", async () => {
  const project = makeFixtureRepo("exit 0", { inspector: false });
  const recordHome = freshHome();
  const brain = fakeBrain({
    onWork: (_brief, workdir) => writeFileSync(join(workdir, "feature.txt"), "work\n"),
    writeup: null,
  });

  const task = await doTask(recordHome, "small change", {
    project,
    brain,
    checkBox: fixtureCheckBox().box,
    attempts: 1,
  });

  assert.equal(task.state, "failed");
  const delivery = deliveryOf(recordHome, task.id);
  assert.equal(delivery?.outcome, "failure-report");
  assert.match(delivery!.evidence, /write-up invalid: the worker returned no write-up/);
});

test("a valid write-up becomes the delivery commit's exact subject and body", async () => {
  const project = makeFixtureRepo("exit 0", { inspector: false });
  const recordHome = freshHome();
  const brain = fakeBrain({
    onWork: (_brief, workdir) => writeFileSync(join(workdir, "feature.txt"), "work\n"),
    writeup: {
      title: "Add the login retry fix",
      what: "Retries login on timeout.",
      why: "Users were seeing spurious failures.",
      how: "Wrapped the call in a retry loop.",
      deviations: "None.",
    },
  });

  const task = await doTask(recordHome, "small change", { project, brain, checkBox: fixtureCheckBox().box });

  assert.equal(task.state, "delivered");
  const delivery = deliveryOf(recordHome, task.id);
  const message = execSync(`git log -1 --format=%B ${delivery!.branch}`, { cwd: project, encoding: "utf8" });
  assert.equal(
    message.trim(),
    "Add the login retry fix\n\n" +
      "What:\nRetries login on timeout.\n\n" +
      "Why:\nUsers were seeing spurious failures.\n\n" +
      "How:\nWrapped the call in a retry loop.\n\n" +
      "Deviations:\nNone."
  );
});

test("doTask on a green project delivers after exactly one attempt", async () => {
  const project = makeFixtureRepo("exit 0", { inspector: false });
  const recordHome = freshHome();
  const brain = fakeBrain();

  const task = await doTask(recordHome, "small change", { project, brain, checkBox: fixtureCheckBox().box });

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A brain standing in for the reference adapter's own live-streaming
 * behavior (issue #70): reports three entries with real pauses between
 * them via emitLiveTranscriptEntry, the same channel the reference
 * adapter uses, before resolving. */
// The write-up comes back as data, not as one of these entries - it must
// be valid, or runAttempts makes the attempt red and retries, and this
// brain's live entries land on disk twice over.
const THIRD_ENTRY_TEXT = "third";

function liveStreamingBrain(): Brain {
  return {
    name: "streaming-fake",
    model: "fake-1",
    async ask() {
      return {};
    },
    async work(_brief, workdir) {
      const now = () => new Date().toISOString();
      emitLiveTranscriptEntry(workdir, { occurredAt: now(), kind: "text", text: "first" });
      await sleep(150);
      emitLiveTranscriptEntry(workdir, { occurredAt: now(), kind: "text", text: "second" });
      await sleep(150);
      emitLiveTranscriptEntry(workdir, { occurredAt: now(), kind: "text", text: THIRD_ENTRY_TEXT });
      return {
        transcript: [
          { occurredAt: now(), kind: "text", text: "first" },
          { occurredAt: now(), kind: "text", text: "second" },
          { occurredAt: now(), kind: "text", text: THIRD_ENTRY_TEXT },
        ],
        session: "s1",
        writeup: { title: "Stream three entries", what: "a", why: "b", how: "c", deviations: "None." },
      };
    },
  };
}

// Negative first (issue #70): a batched "collect the transcript and hand
// it over once the attempt concludes" implementation would write nothing
// to transcript.log until doTask's whole promise resolves - the first
// entry and the third would land on disk in the same instant. This
// starts doTask without awaiting it, then polls the real file on disk
// while the task is still running, proving the first entry is already
// there well before the brain has even produced its third one.
test("doTask writes each transcript entry to disk as it arrives, not batched at the end", async () => {
  const project = makeFixtureRepo("exit 0", { inspector: false });
  const recordHome = freshHome();
  let taskId: string | undefined;

  const donePromise = doTask(recordHome, "small change", {
    project,
    brain: liveStreamingBrain(),
    checkBox: fixtureCheckBox().box,
    onTaskRegistered: (id) => {
      taskId = id;
    },
  });

  const deadline = Date.now() + 10_000;
  while (taskId === undefined && Date.now() < deadline) await sleep(5);
  assert.ok(taskId, "onTaskRegistered must fire before doTask resolves");

  while (readTaskFile(recordHome, taskId!, "transcript.log") === null && Date.now() < deadline) {
    await sleep(5);
  }
  const whileRunning = readTaskFile(recordHome, taskId!, "transcript.log") ?? "";
  assert.ok(whileRunning.includes('"first"'), "the first entry should already be on disk");
  assert.ok(
    !whileRunning.includes("THIRD-MARKER"),
    "the third entry is still 150ms+ away inside the brain - it must not be on disk yet"
  );

  await donePromise;
  const final = readTaskFile(recordHome, taskId!, "transcript.log") ?? "";
  const texts = final
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).text);
  // The last two entries are this adapter's own synthesized `first`,
  // `second`, `third` text entries, in order, with nothing duplicated or
  // dropped between the live writes and runAttempts' own catch-up pass.
  assert.deepEqual(texts, ["first", "second", THIRD_ENTRY_TEXT]);
});

test("doTask writes brief.md verbatim from the request, for every task", async () => {
  const recordHome = freshHome();
  const taskText = "small change, worth checking brief.md holds exactly this text";

  const delivered = await doTask(recordHome, taskText, {
    project: makeFixtureRepo("exit 0", { inspector: false }),
    checkBox: fixtureCheckBox().box,
    brain: fakeBrain(),
  });
  assert.equal(readTaskFile(recordHome, delivered.id, "brief.md"), taskText);

  // Verbatim regardless of how the task ends — a failed task is still
  // evidence of what a Worker was actually given.
  const failed = await doTask(recordHome, taskText, {
    project: makeFixtureRepo("exit 1", { inspector: false }),
    checkBox: fixtureCheckBox().box,
    brain: fakeBrain(),
  });
  assert.equal(failed.state, "failed");
  assert.equal(readTaskFile(recordHome, failed.id, "brief.md"), taskText);
});

test("doTask on an always-red project runs the default fix pass, then reports failure", async () => {
  const project = makeFixtureRepo("exit 1", { inspector: false });
  const recordHome = freshHome();
  const brain = fakeBrain();

  const task = await doTask(recordHome, "any change", { project, brain, checkBox: fixtureCheckBox().box });

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
  const project = makeFixtureRepo("exit 0", { inspector: false });
  const recordHome = freshHome();
  const brain = fakeBrain();

  const task = await doTask(recordHome, "counted attempts", { project, attempts: 4, brain, checkBox: fixtureCheckBox().box });

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
    () => doTask(recordHome, "do something", { project, brain, checkBox: fixtureCheckBox().box }),
    (err: unknown) => err instanceof ForemanError && err.code === "missing-check"
  );

  assert.equal(brain.calls, 0, "no worker should run without a check command");
});

test("doTask honors a registered project's own check command over the check.sh convention", async () => {
  const project = makeFixtureRepo("exit 0", { inspector: false });
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

  const task = await doTask(recordHome, "small change", { project, brain, checkBox: fixtureCheckBox().box });

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

  await assert.rejects(() => doTask(recordHome, "do something", { project, brain: fakeBrain(), checkBox: fixtureCheckBox().box }));

  const worktrees = execSync("git worktree list", { cwd: project, encoding: "utf8" });
  assert.equal(worktrees.trim().split("\n").length, 1, "only the main worktree should remain");
});

test("doTask rejects when no brain is provided", async () => {
  const project = makeFixtureRepo("exit 0", { inspector: false });
  const recordHome = freshHome();

  await assert.rejects(
    () => doTask(recordHome, "small change", { project }),
    (err: unknown) => err instanceof ForemanError && err.code === "no-brain"
  );
});

test("doTask on an undeclared gate change keeps the work on the ordinary branch, it does not discard it", async () => {
  const project = makeFixtureRepo("exit 1", { inspector: false });
  const recordHome = freshHome();
  const brain = fakeBrain({
    onWork: (_brief, workdir) => {
      writeFileSync(join(workdir, "check.sh"), "#!/bin/sh\nexit 0\n");
      writeFileSync(join(workdir, "feature.txt"), "possibly good work\n");
    },
  });

  const task = await doTask(recordHome, "make it pass", { project, brain, checkBox: fixtureCheckBox().box });

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
  const project = makeFixtureRepo("exit 1", { inspector: false });
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

  const task = await doTask(recordHome, "make it pass", { project, brain, checkBox: fixtureCheckBox().box });

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
  const project = makeFixtureRepo("exit 0", { inspector: false });
  const recordHome = freshHome();
  const brain = fakeBrain({
    onWork: (_brief, workdir) => {
      writeFileSync(join(workdir, "app.txt"), "changed\n");
      writeFileSync(join(workdir, "new-file.txt"), "new\n");
    },
  });

  const task = await doTask(recordHome, "edit files", { project, brain, checkBox: fixtureCheckBox().box });
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
  const project = makeFixtureRepo("exit 0", { inspector: false });
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

  const task = await doTask(recordHome, "make it pass", { project, brain, checkBox: fixtureCheckBox().box });

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
  const project = makeFixtureRepo("exit 0", { inspector: false });
  const recordHome = freshHome();
  const brain = fakeBrain({ askQuestions: ["What database should this use?", "Multi-tenant?"] });

  const task = await doTask(recordHome, "build me an app", { project, brain, checkBox: fixtureCheckBox().box });

  assert.equal(task.state, "asking");
  assert.equal(brain.calls, 0, "no worker should run before the Client answers");

  const events = readEventsForTask(recordHome, task.id);
  assert.deepEqual(
    events.map((e) => e.name),
    ["task-received", "ask-cost-recorded", "questions-asked"]
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
  const project = makeFixtureRepo("exit 0", { inspector: false });
  const recordHome = freshHome();
  const brain = fakeBrain(); // no askQuestions configured - nothing to ask

  const task = await doTask(recordHome, "small change", { project, brain, checkBox: fixtureCheckBox().box });

  assert.equal(task.state, "delivered");
  assert.deepEqual(brain.askCalls, ["small change"], "the brain's first pass still runs");
  assert.equal(brain.calls, 1, "exactly one work() call, same as before issue #8");

  const events = readEventsForTask(recordHome, task.id);
  assert.deepEqual(
    events.map((e) => e.name),
    ["task-received", "ask-cost-recorded", "line-cut", "inspection-skipped", "work-started", "check-run", "check-run", "receipt-recorded", "delivered"],
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
  const project = makeFixtureRepo("exit 0", { inspector: false });
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
        checkBox: fixtureCheckBox().box,
      }),
    (err: unknown) => err instanceof LineError && err.code === "cut-failed"
  );
});

test("runProductionRound with isRetry: true reopens the task's own branch", async () => {
  const project = makeFixtureRepo("exit 0", { inspector: false });
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
    checkBox: fixtureCheckBox().box,
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
    checkBox: fixtureCheckBox().box,
  });
  assert.equal(second.state, "delivered");
});
