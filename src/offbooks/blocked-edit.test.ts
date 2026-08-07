import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "../record/index.ts";
import { recordBlockedEditAttempt } from "./blocked-edit.ts";

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-offbooks-blocked-edit-"));
}

test("recordBlockedEditAttempt: keys the event to the registered project the cwd falls under", () => {
  const recordHome = tempRecordHome();
  const project = mkdtempSync(join(tmpdir(), "fabrica-offbooks-project-"));
  writeFileSync(join(recordHome, "projects.toml"), `[projects.spending-app]\npath = "${project}"\n`);

  recordBlockedEditAttempt(recordHome, {
    tool: "Edit",
    target: join(project, "config.json"),
    cwd: project,
    reason: "denied by permissions",
  });

  const events = readEvents(recordHome);
  assert.equal(events.length, 1);
  assert.equal(events[0].name, "edit-attempt-blocked");
  assert.equal(events[0].taskId, "project:spending-app");
  const details = events[0].details as { project: string; tool: string; target: string };
  assert.equal(details.project, "spending-app");
  assert.equal(details.tool, "Edit");
  assert.equal(details.target, join(project, "config.json"));
});

test("recordBlockedEditAttempt: a cwd under no registered project still records, unattributed", () => {
  const recordHome = tempRecordHome();
  recordBlockedEditAttempt(recordHome, { tool: "Write", cwd: "/some/other/place" });

  const events = readEvents(recordHome);
  assert.equal(events.length, 1);
  assert.equal(events[0].taskId, "project:unregistered");
  assert.equal((events[0].details as { project: string | null }).project, null);
});

test("recordBlockedEditAttempt: no projects.toml at all still records, unattributed, never throws", () => {
  const recordHome = tempRecordHome();
  assert.doesNotThrow(() => recordBlockedEditAttempt(recordHome, { tool: "NotebookEdit", cwd: "/anywhere" }));
  assert.equal(readEvents(recordHome).length, 1);
});
