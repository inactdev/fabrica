// runWatchCommand end to end. The sharp edge this command exists for -
// stopping the watch never stops the work - is a process-boundary fact
// proven by construction (this file never spawns or signals anything) and
// demonstrated for real in the PR's own end-to-end run; what these tests
// cover is the CLI-visible behavior: what gets printed, when, and that
// aborting the watch's own signal (standing in for Ctrl-C) cleanly stops
// only the polling loop.

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "../index.ts";
import { appendEvent, recordPath } from "../record/index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { runDoCommand } from "./do-command.ts";
import { runWatchCommand } from "./watch-command.ts";
import { CHECKING_QUIET_CEILING_MS, PRE_WORK_QUIET_CEILING_MS } from "./render.ts";
import type { Brain } from "../index.ts";

// See status-command.test.ts's matching test: runCheck is synchronous
// execSync, so a slow check blocks its own process's event loop start to
// finish - a real, separate detached process (not just an unawaited
// in-process promise) is what lets this test's own polling run at all
// while a check is genuinely in flight.
const FAKE_ENTRY = fileURLToPath(new URL("./helpers/fake-run-task-entry.ts", import.meta.url));

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-cli-watch-command-"));
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
}

async function waitFor(condition: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}

function slowBrain(delayMs: number): Brain {
  return {
    name: "slow",
    model: "slow-1",
    async work(brief: string) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        transcript: [{ occurredAt: new Date().toISOString(), kind: "text", text: `slow brain did: ${brief}` }],
        session: "s1",
      };
    },
    async ask() {
      return {};
    },
  };
}

test("runWatchCommand: prints existing transcript, then stops cleanly on abort", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  const task = await createForeman({ recordHome }).do("small change", { project, brain: fakeBrain() });
  const io = captureIo();
  const controller = new AbortController();

  const watchPromise = runWatchCommand([task.id], {
    recordHome,
    signal: controller.signal,
    installSigintHandler: false,
    pollIntervalMs: 10,
    ...io,
  });
  setTimeout(() => controller.abort(), 30);
  const code = await watchPromise;

  assert.equal(code, 0);
  assert.ok(io.out.some((line) => line.includes("small change")), "existing transcript is printed");
});

test("runWatchCommand: streams a transcript entry that lands after watching starts", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  const brain = slowBrain(120);

  // do() registers the task (writes request.md, appends task-received)
  // synchronously before its first await, so the task directory already
  // exists the instant this call returns its (still-pending) promise.
  const donePromise = createForeman({ recordHome }).do("a slow task", { project, brain });
  const taskId = readdirSync(join(recordHome, "tasks"))[0];

  const io = captureIo();
  const controller = new AbortController();
  const watchPromise = runWatchCommand([taskId], {
    recordHome,
    signal: controller.signal,
    installSigintHandler: false,
    pollIntervalMs: 15,
    ...io,
  });

  await donePromise; // the worker finishes while watch keeps polling
  // The transcript write and this resolution happen in the same
  // synchronous stretch of doTask, so the watch loop needs one more real
  // poll cycle after donePromise settles to be sure it has observed it -
  // otherwise aborting here could race the very write it's meant to see.
  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort();
  const code = await watchPromise;

  assert.equal(code, 0);
  assert.ok(
    io.out.some((line) => line.includes("slow brain did: a slow task")),
    `expected the streamed transcript entry, got: ${JSON.stringify(io.out)}`
  );
  assert.ok(io.out.some((line) => line.includes("task delivered")));
});

test("runWatchCommand: a single heartbeat event shows as a liveness line", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "work-started", details: { project: "/some/project" } });
  appendEvent(recordHome, { taskId: "t1", name: "heartbeat", details: { attempt: 1 } });

  const io = captureIo();
  const controller = new AbortController();
  const watchPromise = runWatchCommand(["t1"], {
    recordHome,
    signal: controller.signal,
    installSigintHandler: false,
    pollIntervalMs: 10,
    ...io,
  });
  setTimeout(() => controller.abort(), 30);
  await watchPromise;

  const heartbeatLines = io.out.filter((line) => line.includes("[heartbeat]"));
  assert.equal(heartbeatLines.length, 1);
  assert.match(heartbeatLines[0], /still working\.\.\.$/);
});

// Client ruling on issue #12's review finding: watch's first poll must
// not replay a whole heartbeat backlog as one line each - attaching to a
// task that's been running an hour (15s interval) would otherwise dump
// ~240 identical lines before anything useful shows, burying whatever
// transcript printed just above. Same collapsing rule fabrica log already
// applies to its full history, applied here to just the catch-up batch.
test("runWatchCommand: a pre-existing heartbeat backlog collapses into one line on attach", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "work-started", details: { project: "/some/project" } });
  for (let i = 0; i < 14; i++) appendEvent(recordHome, { taskId: "t1", name: "heartbeat", details: { attempt: 1 } });

  const io = captureIo();
  const controller = new AbortController();
  const watchPromise = runWatchCommand(["t1"], {
    recordHome,
    signal: controller.signal,
    installSigintHandler: false,
    pollIntervalMs: 10,
    ...io,
  });
  setTimeout(() => controller.abort(), 30);
  await watchPromise;

  const heartbeatLines = io.out.filter((line) => line.includes("[heartbeat]"));
  assert.equal(heartbeatLines.length, 1, `expected the 14 pre-existing heartbeats collapsed to one line, got: ${JSON.stringify(io.out)}`);
  assert.match(heartbeatLines[0], /^\S+  \[heartbeat\]  14 heartbeats over/);
});

test("runWatchCommand: a live heartbeat that lands after catch-up still prints as its own line", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "work-started", details: { project: "/some/project" } });
  for (let i = 0; i < 5; i++) appendEvent(recordHome, { taskId: "t1", name: "heartbeat", details: { attempt: 1 } });

  const io = captureIo();
  const controller = new AbortController();
  const watchPromise = runWatchCommand(["t1"], {
    recordHome,
    signal: controller.signal,
    installSigintHandler: false,
    pollIntervalMs: 10,
    ...io,
  });

  await waitFor(() => io.out.some((line) => line.includes("[heartbeat]")));
  appendEvent(recordHome, { taskId: "t1", name: "heartbeat", details: { attempt: 1 } });
  await waitFor(() => io.out.filter((line) => line.includes("[heartbeat]")).length >= 2);
  controller.abort();
  await watchPromise;

  const heartbeatLines = io.out.filter((line) => line.includes("[heartbeat]"));
  assert.equal(heartbeatLines.length, 2, `expected catch-up (1 collapsed) + 1 live line, got: ${JSON.stringify(io.out)}`);
  assert.match(heartbeatLines[0], /5 heartbeats over/);
  assert.match(heartbeatLines[1], /still working\.\.\.$/);
});

test("runWatchCommand: a task mid-check streams its real elapsed time live, never a quiet alarm", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("sleep 2 && exit 0");

  const doIo = { out: [] as string[], stdout: (l: string) => doIo.out.push(l), stderr: () => {} };
  await runDoCommand(["small change", "--project", project], { recordHome, entryScript: FAKE_ENTRY, ...doIo });
  const taskId = doIo.out[0];

  const io = captureIo();
  const controller = new AbortController();
  const watchPromise = runWatchCommand([taskId], {
    recordHome,
    signal: controller.signal,
    installSigintHandler: false,
    pollIntervalMs: 50,
    ...io,
  });

  const sawChecking = await waitFor(() => io.out.some((line) => /^checking, \d+s so far$/.test(line)));
  controller.abort();
  await watchPromise;

  assert.ok(sawChecking, `expected a live "checking, Xs so far" line, got: ${JSON.stringify(io.out)}`);
  assert.ok(!io.out.some((line) => line.includes("quiet")), "a mid-check task is never flagged quiet");
});

// Client ruling, issue #12 review finding: past CHECKING_QUIET_CEILING_MS
// (4h), a check no longer gets the benefit of the doubt - the only way to
// catch a worker killed mid-check (reboot, OOM) or a check that hung.
test("runWatchCommand: a check stuck past its own long ceiling is flagged quiet live, not shown as honest progress", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "work-started", details: { project: "/some/project" } });
  // appendEvent always stamps the real current time, so a genuinely old
  // "check-run started" event - the only way to exercise a ceiling this
  // long without an actual multi-hour wait - has to be written directly.
  const start = Date.now() - CHECKING_QUIET_CEILING_MS - 1;
  const startEvent = {
    occurredAt: new Date(start).toISOString(),
    taskId: "t1",
    name: "check-run",
    details: { attempt: 1, phase: "started" },
  };
  appendFileSync(recordPath(recordHome), `${JSON.stringify(startEvent)}\n`);

  const io = captureIo();
  const controller = new AbortController();
  const watchPromise = runWatchCommand(["t1"], {
    recordHome,
    signal: controller.signal,
    installSigintHandler: false,
    pollIntervalMs: 10,
    ...io,
  });
  setTimeout(() => controller.abort(), 30);
  await watchPromise;

  assert.ok(
    io.out.some((line) => line.includes("and still not finished")),
    `expected the checking alarm, got: ${JSON.stringify(io.out)}`
  );
  assert.ok(!io.out.some((line) => /^checking, .* so far$/.test(line)), "the plain elapsed line steps aside for the alarm");
});

// Client ruling, issue #12 review finding (quiet-wording-names-
// nonexistent-heartbeat): the checking alarm must name what actually
// happened (a check that started N ago and has not finished), never the
// "no signal since last heartbeat" wording - no heartbeat is ever
// emitted during a check.
test("runWatchCommand: the checking alarm names a stuck check live, not a nonexistent heartbeat", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "work-started", details: { project: "/some/project" } });
  const start = Date.now() - CHECKING_QUIET_CEILING_MS - 1;
  const startEvent = {
    occurredAt: new Date(start).toISOString(),
    taskId: "t1",
    name: "check-run",
    details: { attempt: 1, phase: "started" },
  };
  appendFileSync(recordPath(recordHome), `${JSON.stringify(startEvent)}\n`);

  const io = captureIo();
  const controller = new AbortController();
  const watchPromise = runWatchCommand(["t1"], {
    recordHome,
    signal: controller.signal,
    installSigintHandler: false,
    pollIntervalMs: 10,
    ...io,
  });
  setTimeout(() => controller.abort(), 30);
  await watchPromise;

  assert.ok(!io.out.some((line) => line.includes("heartbeat")), `expected no mention of a heartbeat, got: ${JSON.stringify(io.out)}`);
});

// The pre-work window's own ceiling (PRE_WORK_QUIET_CEILING_MS): a task
// stuck between task-received and work-started past its own long window
// gets the quiet alarm too, with wording that doesn't claim a heartbeat
// that attempts.ts never emits for this window.
test("runWatchCommand: a task stuck before work-started past its own ceiling is flagged quiet live, naming no heartbeat", async () => {
  const recordHome = tempRecordHome();
  const start = Date.now() - PRE_WORK_QUIET_CEILING_MS - 1;
  const receivedEvent = {
    occurredAt: new Date(start).toISOString(),
    taskId: "t1",
    name: "task-received",
    details: { brief: "small change" },
  };
  appendFileSync(recordPath(recordHome), `${JSON.stringify(receivedEvent)}\n`);

  const io = captureIo();
  const controller = new AbortController();
  const watchPromise = runWatchCommand(["t1"], {
    recordHome,
    signal: controller.signal,
    installSigintHandler: false,
    pollIntervalMs: 10,
    ...io,
  });
  const sawQuiet = await waitFor(() => io.out.some((line) => line.includes("no signal recorded yet")));
  controller.abort();
  await watchPromise;

  assert.ok(sawQuiet, `expected the pre-work quiet alarm, got: ${JSON.stringify(io.out)}`);
  assert.ok(!io.out.some((line) => line.includes("heartbeat")), "attempts.ts's heartbeat interval never wraps brain.ask()");
});

// Client ruling on issue #12's review finding: without a terminal notice,
// watching a task already ruled on, or one stopped for questions, looks
// exactly like a hang - it just polls forever with nothing printed and no
// way out but Ctrl-C.
test("runWatchCommand: a closed task (verdict already recorded) gets a terminal notice, not silence", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "work-started", details: { project: "/some/project" } });
  appendEvent(recordHome, {
    taskId: "t1",
    name: "delivered",
    details: { outcome: "done", delivery: { confidence: 100, summary: "done", branch: "fabrica/t1", files: [] } },
  });
  appendEvent(recordHome, { taskId: "t1", name: "verdict-recorded", details: { ruling: "accept", note: "good" } });

  const io = captureIo();
  const controller = new AbortController();
  const watchPromise = runWatchCommand(["t1"], {
    recordHome,
    signal: controller.signal,
    installSigintHandler: false,
    pollIntervalMs: 10,
    ...io,
  });
  setTimeout(() => controller.abort(), 30);
  await watchPromise;

  assert.ok(io.out.some((line) => line.includes("task closed")), `expected a closed notice, got: ${JSON.stringify(io.out)}`);
});

// Client ruling, issue #12 review finding: identical property to "closed"
// - brain.ask() itself threw before any Worker ran, so `fabrica verdict
// ... fix` refuses it (not-delivered) and `fabrica answer` refuses it
// (no-questions-pending) too. Nothing can ever move this task, so watch
// ends on its own instead of polling forever - no Ctrl-C needed here.
test("runWatchCommand: a task whose ask() threw (failed, never delivered) ends the watch on its own", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "ask-failed", details: { error: "the brain is unreachable" } });

  const io = captureIo();
  const controller = new AbortController();
  const code = await runWatchCommand(["t1"], {
    recordHome,
    signal: controller.signal,
    installSigintHandler: false,
    pollIntervalMs: 10,
    ...io,
  });

  assert.equal(code, 0);
  assert.ok(
    io.out.some((line) => line.includes("failed before any work started")),
    `expected the no-fix-path notice, got: ${JSON.stringify(io.out)}`
  );
});

test("runWatchCommand: a task with a real failed DELIVERY keeps polling, unlike an ask() failure", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "work-started", details: { project: "/some/project" } });
  appendEvent(recordHome, {
    taskId: "t1",
    name: "delivered",
    details: { outcome: "failure-report", delivery: { confidence: 0, summary: "red", branch: "fabrica/t1", files: [] } },
  });

  const io = captureIo();
  const controller = new AbortController();
  const watchPromise = runWatchCommand(["t1"], {
    recordHome,
    signal: controller.signal,
    installSigintHandler: false,
    pollIntervalMs: 10,
    ...io,
  });
  setTimeout(() => controller.abort(), 30);
  const code = await watchPromise;

  assert.equal(code, 0);
  assert.ok(io.out.some((line) => line.includes("task failed")));
  assert.ok(!io.out.some((line) => line.includes("failed before any work started")));
});

test("runWatchCommand: a task stopped for questions gets a terminal notice pointing at fabrica answer", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "questions-asked", details: { questions: ["Which endpoint?"] } });

  const io = captureIo();
  const controller = new AbortController();
  const watchPromise = runWatchCommand(["t1"], {
    recordHome,
    signal: controller.signal,
    installSigintHandler: false,
    pollIntervalMs: 10,
    ...io,
  });
  setTimeout(() => controller.abort(), 30);
  await watchPromise;

  assert.ok(io.out.some((line) => line.includes("task asking")), `expected an asking notice, got: ${JSON.stringify(io.out)}`);
  assert.ok(io.out.some((line) => line.includes("fabrica answer t1")), "the notice should point at fabrica answer");
});

test("runWatchCommand: an unknown task id refuses plainly", async () => {
  const io = captureIo();
  const code = await runWatchCommand(["no-such-task"], { recordHome: tempRecordHome(), ...io });

  assert.equal(code, 1);
  assert.deepEqual(io.out, []);
  assert.match(io.err[0], /no task "no-such-task"/);
});

test("runWatchCommand: bad usage refuses with exact instructions", async () => {
  const io = captureIo();
  const code = await runWatchCommand([], { recordHome: tempRecordHome(), ...io });

  assert.equal(code, 1);
  assert.match(io.err[0], /missing <taskId>/);
});

test("runWatchCommand: aborting an already-aborted signal returns immediately", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  const task = await createForeman({ recordHome }).do("small change", { project, brain: fakeBrain() });
  const io = captureIo();
  const controller = new AbortController();
  controller.abort();

  const code = await runWatchCommand([task.id], {
    recordHome,
    signal: controller.signal,
    installSigintHandler: false,
    ...io,
  });

  assert.equal(code, 0);
  assert.ok(io.out.some((line) => line.includes("small change")), "still prints what already happened, once");
});

// The notice tracks WHICH state it was issued for, not merely that one was
// issued: a `fix` verdict wakes the same task back up, and its second
// delivery has to say so too. A one-shot latch would leave the stream
// silently stopping - the exact looks-like-a-hang case the notice exists
// to prevent.
test("runWatchCommand: a second delivery after a fix verdict gets its own notice", async () => {
  const recordHome = tempRecordHome();
  const delivered = { outcome: "done", delivery: { confidence: 100, summary: "done", branch: "fabrica/t1", files: [] } };
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "work-started", details: { project: "/some/project" } });
  appendEvent(recordHome, { taskId: "t1", name: "delivered", details: delivered });

  const io = captureIo();
  const controller = new AbortController();
  const watchPromise = runWatchCommand(["t1"], {
    recordHome,
    signal: controller.signal,
    installSigintHandler: false,
    pollIntervalMs: 10,
    ...io,
  });

  const noticeCount = () => io.out.filter((line) => line.includes("task delivered")).length;
  assert.ok(await waitFor(() => noticeCount() === 1), `expected the first delivered notice, got: ${JSON.stringify(io.out)}`);

  appendEvent(recordHome, { taskId: "t1", name: "verdict-recorded", details: { ruling: "fix", note: "one more thing" } });
  appendEvent(recordHome, { taskId: "t1", name: "work-started", details: { verdict: "fix", project: "/some/project" } });
  // A heartbeat landing proves a poll actually observed the fix round's
  // "working" state, rather than the whole round slipping between polls.
  appendEvent(recordHome, { taskId: "t1", name: "heartbeat", details: { attempt: 2 } });
  assert.ok(await waitFor(() => io.out.some((line) => line.includes("[heartbeat]"))));

  appendEvent(recordHome, { taskId: "t1", name: "delivered", details: delivered });
  const sawSecond = await waitFor(() => noticeCount() === 2, 5_000);
  controller.abort();
  await watchPromise;

  assert.ok(sawSecond, `expected a second delivered notice after the fix round, got: ${JSON.stringify(io.out)}`);
});

// "closed" is the one state that provably cannot change again
// (recordVerdict refuses any further ruling once the last one was accept or
// wrong), so the loop ends itself instead of polling until Ctrl-C.
test("runWatchCommand: a closed task ends the watch itself, without waiting to be stopped", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, {
    taskId: "t1",
    name: "delivered",
    details: { outcome: "done", delivery: { confidence: 100, summary: "done", branch: "fabrica/t1", files: [] } },
  });
  appendEvent(recordHome, { taskId: "t1", name: "verdict-recorded", details: { ruling: "accept", note: "good" } });

  const io = captureIo();
  const safetyStop = new AbortController();
  const timer = setTimeout(() => safetyStop.abort(), 5_000);
  const code = await runWatchCommand(["t1"], {
    recordHome,
    signal: safetyStop.signal,
    installSigintHandler: false,
    pollIntervalMs: 10,
    ...io,
  });
  clearTimeout(timer);

  assert.equal(code, 0);
  assert.equal(safetyStop.signal.aborted, false, "watch should have returned on its own, not been stopped");
  assert.ok(io.out.some((line) => line.includes("task closed")));
});

// A task whose brain.ask() threw is "failed" with nothing ever delivered,
// so `fabrica verdict <id> fix` would be refused with "not-delivered" -
// the notice must not send the Client at it.
test("runWatchCommand: an ask-failed task's notice offers no fix path", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "ask-failed", details: { error: "no credential" } });

  const io = captureIo();
  const controller = new AbortController();
  const watchPromise = runWatchCommand(["t1"], {
    recordHome,
    signal: controller.signal,
    installSigintHandler: false,
    pollIntervalMs: 10,
    ...io,
  });
  const sawNotice = await waitFor(() => io.out.some((line) => line.includes("task failed")));
  controller.abort();
  await watchPromise;

  assert.ok(sawNotice, `expected a failed notice, got: ${JSON.stringify(io.out)}`);
  const notice = io.out.find((line) => line.includes("task failed"))!;
  assert.match(notice, /no `fix` path/);
  assert.doesNotMatch(notice, /verdict wakes the worker/);
});
