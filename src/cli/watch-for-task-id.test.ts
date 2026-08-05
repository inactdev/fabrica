import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTask } from "../record/index.ts";
import { CliError } from "./errors.ts";
import { watchForTaskId } from "./watch-for-task-id.ts";

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-cli-watch-"));
}

test("watchForTaskId: resolves once a matching task registers after a delay", async () => {
  const recordHome = tempRecordHome();
  const taskText = "fix the flaky test";

  const promise = watchForTaskId({ recordHome, taskText, timeoutMs: 5_000 });
  setTimeout(() => registerTask(recordHome, taskText), 150);

  const taskId = await promise;
  assert.match(taskId, /^\d{8}-/);
});

test("watchForTaskId: ignores an unrelated task registered in the same window", async () => {
  const recordHome = tempRecordHome();
  const taskText = "fix the flaky test";

  const promise = watchForTaskId({ recordHome, taskText, timeoutMs: 5_000 });
  setTimeout(() => registerTask(recordHome, "an unrelated task"), 50);
  setTimeout(() => registerTask(recordHome, taskText), 200);

  const taskId = await promise;
  const { readFileSync } = await import("node:fs");
  assert.equal(readFileSync(join(recordHome, "tasks", taskId, "request.md"), "utf8"), taskText);
});

test("watchForTaskId: ignores a task that already existed before watching started", async () => {
  const recordHome = tempRecordHome();
  const taskText = "fix the flaky test";
  const { id: staleId } = registerTask(recordHome, taskText);

  const promise = watchForTaskId({ recordHome, taskText, timeoutMs: 5_000 });
  setTimeout(() => registerTask(recordHome, taskText), 150);

  const taskId = await promise;
  assert.notEqual(taskId, staleId);
});

test("watchForTaskId: times out with an exact-instructions CliError when nothing registers", async () => {
  const recordHome = tempRecordHome();
  await assert.rejects(
    watchForTaskId({ recordHome, taskText: "never happens", timeoutMs: 300 }),
    (err: unknown) =>
      err instanceof CliError && err.code === "registration-timeout" && err.message.includes("cli.log")
  );
});

test("watchForTaskId: tolerates a directory claimed before request.md is written", async () => {
  const recordHome = tempRecordHome();
  const taskText = "fix the flaky test";
  const tasksDir = join(recordHome, "tasks");
  mkdirSync(tasksDir, { recursive: true });

  const promise = watchForTaskId({ recordHome, taskText, timeoutMs: 5_000 });

  // Simulate registerTask's own two-step landing: claim the dir first...
  const partialId = "20260805-fix-the-flaky-test-zz";
  setTimeout(() => mkdirSync(join(tasksDir, partialId)), 50);
  // ...then write request.md a moment later.
  setTimeout(() => writeFileSync(join(tasksDir, partialId, "request.md"), taskText), 150);

  const taskId = await promise;
  assert.equal(taskId, partialId);
});
