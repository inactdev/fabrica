import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QUIET_THRESHOLD_MS,
  checkStartedAt,
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

test("isQuietTooLong: never true for a checking task, no matter how long - it has a known explanation", () => {
  const start = 1_000_000;
  const events: FabricaEvent[] = [
    { occurredAt: new Date(start).toISOString(), taskId: "x", name: "check-run", details: { phase: "started" } },
  ];
  assert.equal(isQuietTooLong("checking", events, start + QUIET_THRESHOLD_MS * 10), false);
});

test("checkStartedAt: the latest started check-run, when nothing has finished it yet", () => {
  const events: FabricaEvent[] = [
    { occurredAt: "2026-01-01T00:00:00.000Z", taskId: "x", name: "work-started" },
    { occurredAt: "2026-01-01T00:00:05.000Z", taskId: "x", name: "check-run", details: { attempt: 1, phase: "started" } },
  ];
  assert.equal(checkStartedAt(events)!.toISOString(), "2026-01-01T00:00:05.000Z");
});

test("checkStartedAt: null once that check has finished", () => {
  const events: FabricaEvent[] = [
    { occurredAt: "2026-01-01T00:00:05.000Z", taskId: "x", name: "check-run", details: { attempt: 1, phase: "started" } },
    { occurredAt: "2026-01-01T00:00:08.000Z", taskId: "x", name: "check-run", details: { attempt: 1, green: true } },
  ];
  assert.equal(checkStartedAt(events), null);
});

test("checkStartedAt: null when no check has ever started", () => {
  const events: FabricaEvent[] = [{ occurredAt: "t0", taskId: "x", name: "work-started" }];
  assert.equal(checkStartedAt(events), null);
});

test("checkStartedAt: a second attempt's start, after the first attempt's check finished", () => {
  const events: FabricaEvent[] = [
    { occurredAt: "2026-01-01T00:00:05.000Z", taskId: "x", name: "check-run", details: { attempt: 1, phase: "started" } },
    { occurredAt: "2026-01-01T00:00:08.000Z", taskId: "x", name: "check-run", details: { attempt: 1, green: false } },
    { occurredAt: "2026-01-01T00:00:20.000Z", taskId: "x", name: "check-run", details: { attempt: 2, phase: "started" } },
  ];
  assert.equal(checkStartedAt(events)!.toISOString(), "2026-01-01T00:00:20.000Z");
});

test("formatStatusLine: flags a delivered task as awaiting verdict", () => {
  const line = formatStatusLine(
    { id: "t1", state: "delivered" },
    { project: "/proj", ageMs: 60_000, quietForMs: null, checkingForMs: null }
  );
  assert.match(line, /AWAITING YOUR VERDICT/);
  assert.match(line, /fabrica verdict t1 accept\|fix\|wrong/);
});

test("formatStatusLine: flags a quiet working task without implying it's stuck or fine", () => {
  const line = formatStatusLine(
    { id: "t1", state: "working" },
    { project: "/proj", ageMs: 600_000, quietForMs: 90_000, checkingForMs: null }
  );
  assert.match(line, /quiet/);
  assert.match(line, /not known to be stuck/);
});

test("formatStatusLine: a plain working task with recent activity has no flag", () => {
  const line = formatStatusLine(
    { id: "t1", state: "working" },
    { project: "/proj", ageMs: 5_000, quietForMs: null, checkingForMs: null }
  );
  assert.doesNotMatch(line, /<-/);
});

test("formatStatusLine: unknown project is said plainly, not left blank", () => {
  const line = formatStatusLine(
    { id: "t1", state: "working" },
    { project: null, ageMs: 1_000, quietForMs: null, checkingForMs: null }
  );
  assert.match(line, /unknown project/);
});

test("formatStatusLine: a checking task says so plainly with its real elapsed time, never quiet", () => {
  const line = formatStatusLine(
    { id: "t1", state: "checking" },
    { project: "/proj", ageMs: 600_000, quietForMs: null, checkingForMs: 120_000 }
  );
  assert.match(line, /checking, 2m so far/);
  assert.doesNotMatch(line, /quiet/);
});

test("formatEventLine: work-started reads as prose, project included", () => {
  const line = formatEventLine({
    occurredAt: "t0",
    taskId: "x",
    name: "work-started",
    details: { project: "/repo" },
  });
  assert.equal(line, "t0  work-started  work started on /repo");
});

test("formatEventLine: a fix round's work-started says so", () => {
  const line = formatEventLine({
    occurredAt: "t0",
    taskId: "x",
    name: "work-started",
    details: { project: "/repo", verdict: "fix" },
  });
  assert.equal(line, "t0  work-started  fix round started on /repo");
});

test("formatEventLine: check-run started vs finished read as prose, not JSON", () => {
  const started = formatEventLine({
    occurredAt: "t0",
    taskId: "x",
    name: "check-run",
    details: { attempt: 1, phase: "started" },
  });
  assert.equal(started, "t0  check-run  check started (attempt 1)");

  const finished = formatEventLine({
    occurredAt: "t1",
    taskId: "x",
    name: "check-run",
    details: { attempt: 1, green: true },
  });
  assert.equal(finished, "t1  check-run  check finished (attempt 1): green");

  const red = formatEventLine({
    occurredAt: "t2",
    taskId: "x",
    name: "check-run",
    details: { attempt: 1, green: false },
  });
  assert.equal(red, "t2  check-run  check finished (attempt 1): red");
});

test("formatEventLine: delivered summarizes without carrying the check's raw output", () => {
  const line = formatEventLine({
    occurredAt: "t0",
    taskId: "x",
    name: "delivered",
    details: {
      outcome: "done",
      delivery: {
        confidence: 100,
        summary: "Completed: add a demo line",
        evidence: "./check.sh -> exit 0\n" + "x".repeat(10_000), // the giant-blob shape this exists to avoid
        branch: "fabrica/x",
        files: ["a.ts", "b.ts"],
        gateChanges: "",
      },
      receipts: [
        { checks: { output: "y".repeat(10_000) } },
        { checks: { output: "z".repeat(10_000) } },
      ],
      totalAttempts: 2,
    },
  });

  assert.equal(
    line,
    "t0  delivered  delivered: done - Completed: add a demo line (confidence 100%, attempt 2/2, branch fabrica/x, 2 file(s))"
  );
  assert.ok(line.length < 300, `expected a bounded line, got ${line.length} chars`);
  assert.doesNotMatch(line, /x{100}/);
  assert.doesNotMatch(line, /y{100}/);
});

test("formatEventLine: delivered flags a declared gate change", () => {
  const line = formatEventLine({
    occurredAt: "t0",
    taskId: "x",
    name: "delivered",
    details: {
      outcome: "discarded-protected-path",
      delivery: {
        confidence: 0,
        summary: "blocked",
        branch: "fabrica/x",
        files: [],
        gateChanges: "loosened rule 9's cap-refusal test per issue #11",
      },
      receipts: [],
      totalAttempts: 1,
    },
  });
  assert.match(line, /gate changes declared/);
});

test("formatEventLine: verdict-recorded reads as prose, note included", () => {
  const withNote = formatEventLine({
    occurredAt: "t0",
    taskId: "x",
    name: "verdict-recorded",
    details: { ruling: "accept", note: "looks right" },
  });
  assert.equal(withNote, "t0  verdict-recorded  verdict: accept - looks right");

  const withoutNote = formatEventLine({
    occurredAt: "t1",
    taskId: "x",
    name: "verdict-recorded",
    details: { ruling: "wrong", note: "" },
  });
  assert.equal(withoutNote, "t1  verdict-recorded  verdict: wrong");
});

test("formatEventLine: heartbeat reads as prose, attempt included", () => {
  const line = formatEventLine({ occurredAt: "t0", taskId: "x", name: "heartbeat", details: { attempt: 1 } });
  assert.equal(line, "t0  heartbeat  heartbeat (attempt 1)");
});

test("formatEventLine: questions-asked reads as numbered questions, not escaped JSON", () => {
  const line = formatEventLine({
    occurredAt: "t0",
    taskId: "x",
    name: "questions-asked",
    details: { questions: ["Which endpoint?", "REST or GraphQL?"] },
  });
  assert.equal(line, "t0  questions-asked  1) Which endpoint?; 2) REST or GraphQL?");
});

test("formatEventLine: an unanticipated event name falls back to bounded, not unbounded, JSON", () => {
  const line = formatEventLine({
    occurredAt: "t0",
    taskId: "x",
    name: "cap-refused",
    details: { reason: "x".repeat(1000) },
  });
  assert.ok(line.length < 300, `expected a bounded fallback, got ${line.length} chars`);
  assert.match(line, /…$/);
});

test("formatQuietNotice: one wording, and it's the one formatStatusLine prints", () => {
  const notice = formatQuietNotice(90_000);
  assert.equal(notice, "quiet 1m, no signal since last heartbeat - not known to be stuck, not known to be fine");
  const line = formatStatusLine(
    { id: "t1", state: "working" },
    { project: "/p", ageMs: 600_000, quietForMs: 90_000, checkingForMs: null }
  );
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
