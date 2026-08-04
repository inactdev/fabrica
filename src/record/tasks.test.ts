import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerTask, readTaskFile, taskDir, taskFilePath, writeTaskFile, appendTaskFile } from "./tasks.ts";
import { readEvents, readEventsForTask } from "./read.ts";
import { TASK_ID_PATTERN } from "./ids.ts";
import { makeTestHome } from "./helpers/test-home.ts";

test("registerTask: creates the task folder with task.md saved verbatim", () => {
  const home = makeTestHome();
  const { id, dir } = registerTask(home, "Fix the login bug\n\nIt happens on retry.");

  assert.match(id, TASK_ID_PATTERN);
  assert.equal(dir, taskDir(home, id));
  assert.ok(existsSync(dir));
  assert.equal(
    readFileSync(taskFilePath(home, id, "task.md"), "utf8"),
    "Fix the login bug\n\nIt happens on retry."
  );
});

test("registerTask: logs task-received on the record for that task id", () => {
  const home = makeTestHome();
  const { id } = registerTask(home, "small change");

  const events = readEventsForTask(home, id);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "task-received");
  assert.equal(events[0].task, id);
});

test("registerTask: two tasks registered in the same second never collide", () => {
  const home = makeTestHome();
  const now = new Date("2026-08-04T12:00:00.000Z"); // identical instant, forced

  const ids = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const { id } = registerTask(home, "the very same task text", { now });
    ids.add(id);
  }

  assert.equal(ids.size, 40, "every id must be unique even when registered at the same instant");
  assert.equal(readEvents(home).length, 40, "every registration must still land its own event");
});

test("readTaskFile: reads back what writeTaskFile/appendTaskFile wrote", () => {
  const home = makeTestHome();
  const { id } = registerTask(home, "small change");

  writeTaskFile(home, id, "plan.md", "1. do the thing\n");
  assert.equal(readTaskFile(home, id, "plan.md"), "1. do the thing\n");

  appendTaskFile(home, id, "task.md", "\n\nQ: which env? A: staging.");
  assert.equal(
    readTaskFile(home, id, "task.md"),
    "small change\n\nQ: which env? A: staging."
  );
});

test("readTaskFile: a file that hasn't been written yet reads as null, not an error", () => {
  const home = makeTestHome();
  const { id } = registerTask(home, "small change");
  assert.equal(readTaskFile(home, id, "verdict"), null);
});

test("writeTaskFile: overwrites, it does not append (delivery.md/verdict are written once)", () => {
  const home = makeTestHome();
  const { id } = registerTask(home, "small change");

  writeTaskFile(home, id, "verdict", "accept");
  writeTaskFile(home, id, "verdict", "fix: retry with staging config");

  assert.equal(readTaskFile(home, id, "verdict"), "fix: retry with staging config");
});
