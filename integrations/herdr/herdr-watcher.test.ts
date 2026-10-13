// Negative tests first (issue #125): proving the watcher does NOT open
// more than one pane per task, and that it DOES flip a pane's reported
// state the moment the record says the Client's attention is needed -
// before any test of the "happy path" heartbeat -> working flow.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { appendEvent, registerTask } from "../../src/record/index.ts";
import { createHerdrWatcher } from "./herdr-watcher.ts";

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

test("a task-received event opens exactly one Herdr pane, named after the task", () => {
  withFakeHerdrLog((readCalls) => {
    const recordHome = makeRecordHome();
    const watcher = createHerdrWatcher({ recordHome, herdrBin: [process.execPath, FAKE_HERDR] });

    const { id } = registerTask(recordHome, "Fix the login bug");
    watcher.pollOnce();
    // A second poll with nothing new must not open a second pane.
    watcher.pollOnce();

    const calls = readCalls();
    const splits = calls.filter((c) => c.args[0] === "pane" && c.args[1] === "split");
    assert.equal(splits.length, 1, `expected exactly one pane, got ${splits.length}`);

    const runs = calls.filter((c) => c.args[0] === "pane" && c.args[1] === "run");
    assert.deepEqual(runs.map((c) => c.args.slice(2)), [["pane-1", `FABRICA_HOME=${recordHome} fabrica watch ${id}`]]);

    const names = calls.filter((c) => c.args[0] === "pane" && c.args[1] === "name");
    assert.deepEqual(names.map((c) => c.args.slice(2)), [["pane-1", "Fix the login bug"]]);
  });
});

test("a questions-asked event flips the task's pane to the blocked state", () => {
  withFakeHerdrLog((readCalls) => {
    const recordHome = makeRecordHome();
    const watcher = createHerdrWatcher({ recordHome, herdrBin: [process.execPath, FAKE_HERDR] });

    const { id } = registerTask(recordHome, "Fix the login bug");
    watcher.pollOnce();

    appendEvent(recordHome, { taskId: id, name: "questions-asked", details: { questions: ["Which database?"] } });
    watcher.pollOnce();

    const reports = readCalls().filter((c) => c.args[0] === "pane" && c.args[1] === "report_agent");
    assert.deepEqual(reports.map((c) => c.args.slice(2)), [["pane-1", "blocked"]]);
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

    const watcher = createHerdrWatcher({ recordHome, herdrBin: [process.execPath, FAKE_HERDR] });
    watcher.pollOnce();

    assert.deepEqual(readCalls(), []);
  });
});
