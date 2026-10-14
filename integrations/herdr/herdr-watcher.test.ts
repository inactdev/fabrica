// Negative tests first (issue #125): proving the watcher does NOT open
// more than one pane per task, and that it DOES flip a pane's reported
// state the moment the record says the Client's attention is needed -
// before any test of the "happy path" heartbeat -> working flow.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { appendEvent, registerTask } from "../../src/record/index.ts";
import { createHerdrWatcher, isHerdrWatcherRunning } from "./herdr-watcher.ts";

const FAKE_HERDR = join(dirname(fileURLToPath(import.meta.url)), "helpers", "fake-herdr.mjs");

function makeRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-herdr-record-"));
}

interface LoggedCall {
  args: string[];
}

function withFakeHerdrLog(run: (readCalls: () => LoggedCall[]) => void): void {
  const logPath = join(mkdtempSync(join(tmpdir(), "fabrica-herdr-log-")), "calls.jsonl");
  const previous = process.env.FAKE_HERDR_LOG;
  process.env.FAKE_HERDR_LOG = logPath;
  try {
    run(() =>
      existsSync(logPath)
        ? readFileSync(logPath, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : []
    );
  } finally {
    if (previous === undefined) delete process.env.FAKE_HERDR_LOG;
    else process.env.FAKE_HERDR_LOG = previous;
  }
}

const BASE_PANE_ID = "w1:p0"; // the watcher's own pane, in every test - never seen directly, only split from

function watcherOver(recordHome: string): ReturnType<typeof createHerdrWatcher> {
  return createHerdrWatcher({ recordHome, herdrBin: [process.execPath, FAKE_HERDR], basePaneId: BASE_PANE_ID });
}

test("a task-received event opens exactly one Herdr pane, named and summarized after the task", () => {
  withFakeHerdrLog((readCalls) => {
    const recordHome = makeRecordHome();
    const watcher = watcherOver(recordHome);

    const { id } = registerTask(recordHome, "Fix the login bug");
    watcher.pollOnce();
    // A second poll with nothing new must not open a second pane.
    watcher.pollOnce();

    const calls = readCalls();
    const splits = calls.filter((c) => c.args[0] === "pane" && c.args[1] === "split");
    assert.equal(splits.length, 1, `expected exactly one pane, got ${splits.length}`);
    assert.deepEqual(splits[0].args.slice(2), [BASE_PANE_ID, "--direction", "right"]);

    const runs = calls.filter((c) => c.args[0] === "pane" && c.args[1] === "run");
    assert.deepEqual(runs.map((c) => c.args.slice(2)), [["w1:p1", `FABRICA_HOME=${recordHome} fabrica watch ${id}`]]);

    const renames = calls.filter((c) => c.args[0] === "agent" && c.args[1] === "rename");
    assert.deepEqual(renames.map((c) => c.args.slice(2)), [["w1:p1", "Fix the login bug"]]);

    const summaries = calls.filter((c) => c.args[0] === "pane" && c.args[1] === "report-metadata");
    assert.deepEqual(summaries.map((c) => c.args.slice(2)), [
      ["w1:p1", "--source", "custom:fabrica-display", "--token", "summary=Fix the login bug"],
    ]);
  });
});

test("a questions-asked event flips the task's pane to the blocked state", () => {
  withFakeHerdrLog((readCalls) => {
    const recordHome = makeRecordHome();
    const watcher = watcherOver(recordHome);

    const { id } = registerTask(recordHome, "Fix the login bug");
    watcher.pollOnce();

    appendEvent(recordHome, { taskId: id, name: "questions-asked", details: { questions: ["Which database?"] } });
    watcher.pollOnce();

    const reports = readCalls().filter((c) => c.args[0] === "pane" && c.args[1] === "report-agent");
    assert.deepEqual(reports.map((c) => c.args.slice(2)), [
      ["w1:p1", "--source", "custom:fabrica", "--agent", `fabrica-${id}`, "--state", "blocked"],
    ]);
  });
});

test("a task this watcher never opened a pane for (received before it started) is ignored", () => {
  withFakeHerdrLog((readCalls) => {
    const recordHome = makeRecordHome();
    // Registered, and already past questions, before the watcher exists -
    // this watcher drains that history at startup rather than reopening a
    // pane for a task that may already be long closed.
    const { id } = registerTask(recordHome, "Older task");
    appendEvent(recordHome, { taskId: id, name: "questions-asked", details: { questions: ["?"] } });

    const watcher = watcherOver(recordHome);
    watcher.pollOnce();

    assert.deepEqual(readCalls(), []);
  });
});

test("isHerdrWatcherRunning: false with no pid file at all", () => {
  const recordHome = makeRecordHome();
  assert.equal(isHerdrWatcherRunning(recordHome), false);
});

test("isHerdrWatcherRunning: true when the pid file names a real, live process", () => {
  const recordHome = makeRecordHome();
  writeFileSync(join(recordHome, "herdr-watcher.pid"), String(process.pid), "utf8");

  assert.equal(isHerdrWatcherRunning(recordHome), true);
});

test("isHerdrWatcherRunning: false, and the stale file is removed, when the pid names a process that's gone", () => {
  const recordHome = makeRecordHome();
  // A real pid, guaranteed dead by the time this runs: spawn a trivial
  // child and wait for it to exit.
  const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const deadPid = dead.pid;
  assert.ok(typeof deadPid === "number" && deadPid > 0);

  const pidFile = join(recordHome, "herdr-watcher.pid");
  writeFileSync(pidFile, String(deadPid), "utf8");

  assert.equal(isHerdrWatcherRunning(recordHome), false);
  assert.equal(existsSync(pidFile), false, "a stale pid file should be cleaned up");
});

test("createHerdrWatcher refuses to start with no pane to split from", () => {
  const recordHome = makeRecordHome();
  const previous = process.env.HERDR_PANE_ID;
  delete process.env.HERDR_PANE_ID;
  try {
    assert.throws(
      () => createHerdrWatcher({ recordHome, herdrBin: [process.execPath, FAKE_HERDR] }),
      /no pane to split from/
    );
  } finally {
    if (previous !== undefined) process.env.HERDR_PANE_ID = previous;
  }
});
