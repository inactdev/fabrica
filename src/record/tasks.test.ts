import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerTask, readTaskFile, taskDir, taskFilePath, writeTaskFile, appendTaskFile } from "./tasks.ts";
import { readEvents, readEventsForTask } from "./read.ts";
import { TASK_ID_PATTERN } from "./ids.ts";
import { makeTestHome } from "./helpers/test-home.ts";

test("registerTask: creates the task folder with request.md saved verbatim", () => {
  const recordHome = makeTestHome();
  const { id, dir } = registerTask(recordHome, "Fix the login bug\n\nIt happens on retry.");

  assert.match(id, TASK_ID_PATTERN);
  assert.equal(dir, taskDir(recordHome, id));
  assert.ok(existsSync(dir));
  assert.equal(
    readFileSync(taskFilePath(recordHome, id, "request.md"), "utf8"),
    "Fix the login bug\n\nIt happens on retry."
  );
});

test("registerTask: logs task-received on the record for that task id", () => {
  const recordHome = makeTestHome();
  const { id } = registerTask(recordHome, "small change");

  const events = readEventsForTask(recordHome, id);
  assert.equal(events.length, 1);
  assert.equal(events[0].name, "task-received");
  assert.equal(events[0].taskId, id);
});

test("registerTask: two tasks registered in the same second never collide", () => {
  const recordHome = makeTestHome();
  const now = new Date("2026-08-04T12:00:00.000Z"); // identical instant, forced

  const ids = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const { id } = registerTask(recordHome, "the very same task text", { now });
    ids.add(id);
  }

  assert.equal(ids.size, 40, "every id must be unique even when registered at the same instant");
  assert.equal(readEvents(recordHome).length, 40, "every registration must still land its own event");
});

test("readTaskFile: reads back what writeTaskFile/appendTaskFile wrote", () => {
  const recordHome = makeTestHome();
  const { id } = registerTask(recordHome, "small change");

  writeTaskFile(recordHome, id, "plan.md", "1. do the thing\n");
  assert.equal(readTaskFile(recordHome, id, "plan.md"), "1. do the thing\n");

  appendTaskFile(recordHome, id, "answers.md", "Q: which env? A: staging.\n");
  appendTaskFile(recordHome, id, "answers.md", "Q: which port? A: 8080.\n");
  assert.equal(
    readTaskFile(recordHome, id, "answers.md"),
    "Q: which env? A: staging.\nQ: which port? A: 8080.\n"
  );
});

test("readTaskFile: a file that hasn't been written yet reads as null, not an error", () => {
  const recordHome = makeTestHome();
  const { id } = registerTask(recordHome, "small change");
  assert.equal(readTaskFile(recordHome, id, "verdict"), null);
});

test("writeTaskFile: overwrites, it does not append (delivery.md/verdict are written once)", () => {
  const recordHome = makeTestHome();
  const { id } = registerTask(recordHome, "small change");

  writeTaskFile(recordHome, id, "verdict", "accept");
  writeTaskFile(recordHome, id, "verdict", "fix: retry with staging config");

  assert.equal(readTaskFile(recordHome, id, "verdict"), "fix: retry with staging config");
});
