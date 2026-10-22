// Issue #267's third ask, the live view's half: the "Checks" column on a
// task row shows what the repository's own checks said about the pull
// request - the same phrase, with the same label, `fabrica status` puts
// on its own line - rather than stopping at Inspector's verdict.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, registerTask } from "../../src/record/index.ts";
import { createRecordView } from "./record-view.ts";

function recordWithChecks(details: unknown, extra: { inspection?: boolean } = {}): { recordHome: string; taskId: string } {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-live-ci-"));
  const { id: taskId } = registerTask(recordHome, "a task");
  appendEvent(recordHome, { taskId, name: "work-started", details: { project: "/p" } });
  if (extra.inspection !== false) {
    appendEvent(recordHome, { taskId, name: "inspection-finished", details: { verdict: "green", report: "ok" } });
  }
  appendEvent(recordHome, { taskId, name: "ci-checks-finished", details });
  return { recordHome, taskId };
}

test("the Checks column shows the pull request's own checks once they have been read", () => {
  const { recordHome, taskId } = recordWithChecks({
    prUrl: "https://github.com/o/r/pull/7",
    sha: "abc",
    verdict: "red",
    summary: "5 green, rehearsal red",
    green: 5,
    red: ["rehearsal"],
    unknown: [],
  });
  const view = createRecordView(recordHome, { baseStanding: () => null });
  assert.equal(view.getTask(taskId, Date.now())?.checks, "CI: 5 green, rehearsal red");
});

test("the latest judgement wins, and the checks read last", () => {
  // Inspector's own green is recorded before the checks are read, so the
  // column must end on the checks - otherwise the page says "inspector:
  // green" about a pull request that is red.
  const { recordHome, taskId } = recordWithChecks({ verdict: "unknown", summary: "1 unknown (rehearsal)" });
  const view = createRecordView(recordHome, { baseStanding: () => null });
  assert.equal(view.getTask(taskId, Date.now())?.checks, "CI: 1 unknown (rehearsal)");
});

test("a read that recorded no phrase still names its verdict rather than showing nothing", () => {
  const { recordHome, taskId } = recordWithChecks({ verdict: "unreadable", summary: "" });
  const view = createRecordView(recordHome, { baseStanding: () => null });
  assert.equal(view.getTask(taskId, Date.now())?.checks, "CI: unreadable");
});

test("a task whose pull request was never read keeps Inspector's own verdict in the column", () => {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-live-ci-"));
  const { id: taskId } = registerTask(recordHome, "a task");
  appendEvent(recordHome, { taskId, name: "work-started", details: { project: "/p" } });
  appendEvent(recordHome, { taskId, name: "inspection-finished", details: { verdict: "green", report: "ok" } });
  const view = createRecordView(recordHome, { baseStanding: () => null });
  assert.equal(view.getTask(taskId, Date.now())?.checks, "inspector: green");
});
