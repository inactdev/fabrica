import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { appendEvent } from "./append.ts";
import { readEvents, readEventsForTask } from "./read.ts";
import { makeTestHome } from "./helpers/test-home.ts";

test("readEvents: an unwritten record reads as empty, not an error", () => {
  const home = makeTestHome();
  assert.deepEqual(readEvents(home), []);
});

test("readEvents: returns every event in write order", () => {
  const home = makeTestHome();
  appendEvent(home, { task: "t1", event: "task-received" });
  appendEvent(home, { task: "t2", event: "task-received" });
  appendEvent(home, { task: "t1", event: "work-started" });

  const events = readEvents(home).map((e) => `${e.task}:${e.event}`);
  assert.deepEqual(events, ["t1:task-received", "t2:task-received", "t1:work-started"]);
});

test("readEventsForTask: filters to just the one task, order preserved", () => {
  const home = makeTestHome();
  appendEvent(home, { task: "t1", event: "task-received" });
  appendEvent(home, { task: "t2", event: "task-received" });
  appendEvent(home, { task: "t1", event: "work-started" });
  appendEvent(home, { task: "t1", event: "delivered" });

  const events = readEventsForTask(home, "t1").map((e) => e.event);
  assert.deepEqual(events, ["task-received", "work-started", "delivered"]);
});

test("readEventsForTask: an unknown task id reads as empty, not an error", () => {
  const home = makeTestHome();
  appendEvent(home, { task: "t1", event: "task-received" });
  assert.deepEqual(readEventsForTask(home, "ghost"), []);
});

test("readEvents: mutating one call's result never affects the next call's result", () => {
  const home = makeTestHome();
  appendEvent(home, { task: "t1", event: "task-received" });

  const first = readEvents(home);
  first.push({ ts: "fake", task: "t1", event: "forged" });
  first[0].event = "tampered";

  const second = readEvents(home);
  assert.equal(second.length, 1);
  assert.equal(second[0].event, "task-received");
});

test("readEvents: a reader polling during concurrent writers never throws or sees a torn line", async () => {
  const home = makeTestHome();
  const workerPath = fileURLToPath(new URL("./helpers/concurrent-append-worker.ts", import.meta.url));
  const tsxBin = join(process.cwd(), "node_modules", ".bin", "tsx");

  const child = spawn(tsxBin, [workerPath, home, "t1", "500", "writer"]);
  let done = false;
  let exitCode: number | null = null;
  let spawnError: Error | null = null;
  child.on("exit", (code) => {
    exitCode = code;
    done = true;
  });
  child.on("error", (err) => {
    spawnError = err;
    done = true;
  });

  let pollCount = 0;
  let lastLen = 0;
  while (!done) {
    const events = readEvents(home); // must never throw, even mid-write
    assert.ok(events.length >= lastLen, "event count must never appear to shrink while reading");
    lastLen = events.length;
    pollCount += 1;
    await yieldToEventLoop();
  }

  assert.equal(spawnError, null);
  assert.equal(exitCode, 0);
  assert.equal(readEvents(home).length, 500);
  assert.ok(pollCount > 0, "sanity: the poll loop must actually have run at least once");
});
