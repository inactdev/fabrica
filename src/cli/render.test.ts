import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QUIET_THRESHOLD_MS,
  formatAge,
  formatEventLine,
  formatQuietNotice,
  formatStatusLine,
  formatTranscriptLine,
  isQuietTooLong,
  lastActivityAt,
  projectFromEvents,
} from "./render.ts";
import type { FabricaEvent } from "../index.ts";

test("formatAge: seconds, minutes, hours, days", () => {
  assert.equal(formatAge(5_000), "5s");
  assert.equal(formatAge(59_000), "59s");
  assert.equal(formatAge(60_000), "1m");
  assert.equal(formatAge(3_600_000), "1h");
  assert.equal(formatAge(3_600_000 + 5 * 60_000), "1h5m");
  assert.equal(formatAge(24 * 3_600_000), "1d");
  assert.equal(formatAge(24 * 3_600_000 + 3 * 3_600_000), "1d3h");
});

test("projectFromEvents: reads the latest event carrying a project", () => {
  const events: FabricaEvent[] = [
    { occurredAt: "t0", taskId: "x", name: "task-received" },
    { occurredAt: "t1", taskId: "x", name: "work-started", details: { project: "/a" } },
    { occurredAt: "t2", taskId: "x", name: "check-run", details: { attempt: 1, green: false } },
  ];
  assert.equal(projectFromEvents(events), "/a");
});

test("projectFromEvents: null when no event carries one yet", () => {
  const events: FabricaEvent[] = [{ occurredAt: "t0", taskId: "x", name: "task-received" }];
  assert.equal(projectFromEvents(events), null);
});

test("lastActivityAt: the last event's timestamp", () => {
  const events: FabricaEvent[] = [
    { occurredAt: "2026-01-01T00:00:00.000Z", taskId: "x", name: "task-received" },
    { occurredAt: "2026-01-01T00:00:05.000Z", taskId: "x", name: "work-started" },
  ];
  assert.equal(lastActivityAt(events)!.toISOString(), "2026-01-01T00:00:05.000Z");
});

test("isQuietTooLong: false for a delivered task, no matter how old", () => {
  const events: FabricaEvent[] = [{ occurredAt: "2020-01-01T00:00:00.000Z", taskId: "x", name: "delivered" }];
  assert.equal(isQuietTooLong("delivered", events, Date.now()), false);
});

test("isQuietTooLong: true only once a working task's silence exceeds the threshold", () => {
  const start = 1_000_000;
  const events: FabricaEvent[] = [{ occurredAt: new Date(start).toISOString(), taskId: "x", name: "work-started" }];
  assert.equal(isQuietTooLong("working", events, start + QUIET_THRESHOLD_MS - 1), false);
  assert.equal(isQuietTooLong("working", events, start + QUIET_THRESHOLD_MS + 1), true);
});

test("formatStatusLine: flags a delivered task as awaiting verdict", () => {
  const line = formatStatusLine(
    { id: "t1", state: "delivered" },
    { project: "/proj", ageMs: 60_000, quietForMs: null }
  );
  assert.match(line, /AWAITING YOUR VERDICT/);
  assert.match(line, /fabrica verdict t1 accept\|fix\|wrong/);
});

test("formatStatusLine: flags a quiet working task without implying it's stuck or fine", () => {
  const line = formatStatusLine(
    { id: "t1", state: "working" },
    { project: "/proj", ageMs: 600_000, quietForMs: 90_000 }
  );
  assert.match(line, /quiet/);
  assert.match(line, /not known to be stuck/);
});

test("formatStatusLine: a plain working task with recent activity has no flag", () => {
  const line = formatStatusLine(
    { id: "t1", state: "working" },
    { project: "/proj", ageMs: 5_000, quietForMs: null }
  );
  assert.doesNotMatch(line, /<-/);
});

test("formatStatusLine: unknown project is said plainly, not left blank", () => {
  const line = formatStatusLine({ id: "t1", state: "working" }, { project: null, ageMs: 1_000, quietForMs: null });
  assert.match(line, /unknown project/);
});

test("formatEventLine: timestamp, name, and compacted details", () => {
  const line = formatEventLine({
    occurredAt: "2026-01-01T00:00:00.000Z",
    taskId: "x",
    name: "check-run",
    details: { attempt: 1, green: true },
  });
  assert.equal(line, '2026-01-01T00:00:00.000Z  check-run  {"attempt":1,"green":true}');
});

test("formatQuietNotice: one wording, and it's the one formatStatusLine prints", () => {
  const notice = formatQuietNotice(90_000);
  assert.equal(notice, "quiet 1m, no signal since last heartbeat - not known to be stuck, not known to be fine");
  const line = formatStatusLine({ id: "t1", state: "working" }, { project: "/p", ageMs: 600_000, quietForMs: 90_000 });
  assert.ok(line.endsWith(notice), `status line should end with the shared notice, got: ${line}`);
});

test("formatTranscriptLine: timestamp, kind, text", () => {
  assert.equal(
    formatTranscriptLine({ occurredAt: "2026-01-01T00:00:00.000Z", kind: "text", text: "did a thing" }),
    "2026-01-01T00:00:00.000Z  [text]  did a thing"
  );
});

test("formatEventLine: no details, no trailing blob", () => {
  const line = formatEventLine({ occurredAt: "2026-01-01T00:00:00.000Z", taskId: "x", name: "task-received" });
  assert.equal(line, "2026-01-01T00:00:00.000Z  task-received");
});
