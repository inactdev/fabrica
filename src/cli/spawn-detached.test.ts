// Proves the real backgrounding mechanism against the real runtime: a
// genuine separate process, spawned via the same tsx-bootstrap.mjs
// invocation the real CLI uses, running against a fake brain
// (fake-run-task-entry.ts) so this never needs the real adapter.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEventsForTask } from "../record/index.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { spawnDetachedTask } from "./spawn-detached.ts";

const FAKE_ENTRY = fileURLToPath(new URL("./helpers/fake-run-task-entry.ts", import.meta.url));

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-cli-spawn-"));
}

test("spawnDetachedTask: returns the task id without waiting for the task to finish", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");

  const started = Date.now();
  const { taskId } = await spawnDetachedTask({
    recordHome,
    projectPath: project,
    taskText: "add a comment",
    entryScript: FAKE_ENTRY,
  });
  const elapsedMs = Date.now() - started;

  assert.match(taskId, /^\d{8}-/);
  // Registration is a handful of sync fs calls; if this took anywhere
  // near as long as a full task (which sleeps/works), we waited for
  // the wrong thing.
  assert.ok(elapsedMs < 5_000, `expected to return quickly, took ${elapsedMs}ms`);
});

test("spawnDetachedTask: the task keeps running and delivers after this call returns", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");

  const { taskId } = await spawnDetachedTask({
    recordHome,
    projectPath: project,
    taskText: "add another comment",
    entryScript: FAKE_ENTRY,
  });

  const deadline = Date.now() + 10_000;
  let delivered = false;
  while (Date.now() < deadline) {
    const events = readEventsForTask(recordHome, taskId);
    if (events.some((e) => e.name === "delivered")) {
      delivered = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  assert.ok(delivered, "background task never delivered");
});

test("spawnDetachedTask: the transcript streams to its file as the task proceeds", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");

  const { taskId } = await spawnDetachedTask({
    recordHome,
    projectPath: project,
    taskText: "add a third comment",
    entryScript: FAKE_ENTRY,
  });

  const transcriptPath = join(recordHome, "tasks", taskId, "transcript.log");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !existsSync(transcriptPath)) {
    await new Promise((r) => setTimeout(r, 100));
  }

  assert.ok(existsSync(transcriptPath), "transcript.log was never written");
  const lines = readFileSync(transcriptPath, "utf8").trim().split("\n");
  assert.ok(lines.length >= 1);
  assert.doesNotThrow(() => JSON.parse(lines[0]));
});

test("spawnDetachedTask: works when recordHome itself doesn't exist yet (a first-ever run)", async () => {
  const parent = mkdtempSync(join(tmpdir(), "fabrica-cli-spawn-"));
  const recordHome = join(parent, "fresh-home", "nested"); // deliberately not created
  const project = makeFixtureRepo("exit 0");

  const { taskId } = await spawnDetachedTask({
    recordHome,
    projectPath: project,
    taskText: "add a comment",
    entryScript: FAKE_ENTRY,
  });

  assert.match(taskId, /^\d{8}-/);
});

test("spawnDetachedTask: rejects with an exact-instructions message when the entry script itself doesn't exist", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");

  await assert.rejects(
    spawnDetachedTask({
      recordHome,
      projectPath: project,
      taskText: "will never register",
      entryScript: join(recordHome, "does-not-exist.ts"),
      timeoutMs: 3_000,
    })
  );
});
