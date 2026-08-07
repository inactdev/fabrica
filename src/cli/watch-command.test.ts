// runWatchCommand end to end. The sharp edge this command exists for -
// stopping the watch never stops the work - is a process-boundary fact
// proven by construction (this file never spawns or signals anything) and
// demonstrated for real in the PR's own end-to-end run; what these tests
// cover is the CLI-visible behavior: what gets printed, when, and that
// aborting the watch's own signal (standing in for Ctrl-C) cleanly stops
// only the polling loop.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "../index.ts";
import { appendEvent } from "../record/index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { runWatchCommand } from "./watch-command.ts";
import type { Brain } from "../index.ts";

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-cli-watch-command-"));
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
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

test("runWatchCommand: heartbeat events show as liveness lines", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "work-started", details: { project: "/some/project" } });
  appendEvent(recordHome, { taskId: "t1", name: "heartbeat", details: { attempt: 1 } });
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
  assert.equal(heartbeatLines.length, 2);
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
