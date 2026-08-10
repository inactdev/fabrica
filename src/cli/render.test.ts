import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHECKING_QUIET_CEILING_MS,
  QUIET_THRESHOLD_MS,
  checkStartedAt,
  formatAge,
  formatEventLine,
  formatEventLines,
  formatQuietNotice,
  formatStatusLine,
  formatTerminalNotice,
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

test("isQuietTooLong: false for a checking task well within its own long ceiling - it has a known explanation", () => {
  const start = 1_000_000;
  const events: FabricaEvent[] = [
    { occurredAt: new Date(start).toISOString(), taskId: "x", name: "check-run", details: { phase: "started" } },
  ];
  // Ten times the ordinary QUIET_THRESHOLD_MS (45s) is still nowhere near
  // CHECKING_QUIET_CEILING_MS (4h) - a real, slow test suite easily runs
  // this long, and the exemption exists precisely so that isn't flagged.
  assert.equal(isQuietTooLong("checking", events, start + QUIET_THRESHOLD_MS * 10), false);
});

// Client ruling, issue #12 review finding: below CHECKING_QUIET_CEILING_MS
// the exemption holds no matter what, but past it "checking" becomes
// eligible for the alarm too - the only way to catch a worker killed
// mid-check (reboot, OOM) or a check that hung, where the record's last
// event stays a "check-run started" forever with no finish ever coming.
test("isQuietTooLong: false right up to CHECKING_QUIET_CEILING_MS, true just past it", () => {
  const start = 1_000_000;
  const events: FabricaEvent[] = [
    { occurredAt: new Date(start).toISOString(), taskId: "x", name: "check-run", details: { phase: "started" } },
  ];
  assert.equal(isQuietTooLong("checking", events, start + CHECKING_QUIET_CEILING_MS - 1), false);
  assert.equal(isQuietTooLong("checking", events, start + CHECKING_QUIET_CEILING_MS + 1), true);
});

test("isQuietTooLong: a checking task with no recorded start at all is never flagged (defensive, shouldn't happen for a real task)", () => {
  const events: FabricaEvent[] = [{ occurredAt: "t0", taskId: "x", name: "task-received" }];
  assert.equal(isQuietTooLong("checking", events, Date.now() + CHECKING_QUIET_CEILING_MS * 10), false);
});

test("isQuietTooLong: never true for the pre-work ask() window, no matter how long - it has a known explanation too", () => {
  const start = 1_000_000;
  // Only "task-received" so far: stateOf reports "working" (its default),
  // but no "work-started" has landed - this is brain.ask()'s window, not
  // a worker gone silent (issue #12 review finding, Client ruling: treat
  // it exactly like "checking").
  const events: FabricaEvent[] = [{ occurredAt: new Date(start).toISOString(), taskId: "x", name: "task-received" }];
  assert.equal(isQuietTooLong("working", events, start + QUIET_THRESHOLD_MS * 10), false);
});

test("isQuietTooLong: true once a REAL working task (work-started landed) goes silent, even right after task-received", () => {
  const start = 1_000_000;
  const events: FabricaEvent[] = [
    { occurredAt: new Date(start).toISOString(), taskId: "x", name: "task-received" },
    { occurredAt: new Date(start + 1_000).toISOString(), taskId: "x", name: "work-started" },
  ];
  assert.equal(isQuietTooLong("working", events, start + 1_000 + QUIET_THRESHOLD_MS + 1), true);
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

test("formatStatusLine: a checking task within its ceiling says so plainly with its real elapsed time, never quiet", () => {
  const line = formatStatusLine(
    { id: "t1", state: "checking" },
    { project: "/proj", ageMs: 600_000, quietForMs: null, checkingForMs: 120_000 }
  );
  assert.match(line, /checking, 2m so far/);
  assert.doesNotMatch(line, /quiet/);
});

// Client ruling, issue #12 review finding: once isQuietTooLong has ruled a
// checking task quiet (past CHECKING_QUIET_CEILING_MS), the quiet alarm
// takes over the display the same way it would for any other state -
// callers signal this by passing both a non-null checkingForMs (state is
// still "checking") and a non-null quietForMs (the caller's own
// isQuietTooLong call came back true).
test("formatStatusLine: a checking task past its ceiling shows the quiet alarm, not the plain elapsed line", () => {
  const line = formatStatusLine(
    { id: "t1", state: "checking" },
    { project: "/proj", ageMs: 600_000, quietForMs: 5 * 60 * 60 * 1000, checkingForMs: 5 * 60 * 60 * 1000 }
  );
  assert.match(line, /quiet/);
  assert.doesNotMatch(line, /checking, .* so far/);
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
    "t0  delivered  delivered: done - Completed: add a demo line (confidence 100%, attempt 2, branch fabrica/x, 2 file(s))"
  );
  assert.ok(line.length < 300, `expected a bounded line, got ${line.length} chars`);
  assert.doesNotMatch(line, /x{100}/);
  assert.doesNotMatch(line, /y{100}/);
});

// Client ruling, issue #12 review finding: never print a ratio that can
// invert. A fix round draws no budget of its own (issue #65), so once one
// has run, receipts.length can exceed the task's original totalAttempts -
// "attempt 3/2" is exactly the unreadable output this rendering exists to
// eliminate, so the count stands alone with no denominator at all.
test("formatEventLine: delivered after a fix round shows the attempt count alone, never a ratio that can invert", () => {
  const line = formatEventLine({
    occurredAt: "t0",
    taskId: "x",
    name: "delivered",
    details: {
      outcome: "done",
      delivery: { confidence: 100, summary: "fixed per note", branch: "fabrica/x", files: [], gateChanges: "" },
      receipts: [{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }],
      totalAttempts: 2,
    },
  });

  assert.match(line, /attempt 3/);
  assert.doesNotMatch(line, /attempt \d+\/\d+/, "no digit/digit ratio anywhere, even though the branch itself contains a slash");
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

test("formatEventLine: line-cut reads as prose, distinguishing a fresh cut from a reopen", () => {
  const cut = formatEventLine({
    occurredAt: "t0",
    taskId: "x",
    name: "line-cut",
    details: { branch: "fabrica/x", reopened: false },
  });
  assert.equal(cut, "t0  line-cut  line cut: fabrica/x");

  const reopened = formatEventLine({
    occurredAt: "t1",
    taskId: "x",
    name: "line-cut",
    details: { branch: "fabrica/x", reopened: true },
  });
  assert.equal(reopened, "t1  line-cut  line reopened: fabrica/x");
});

test("formatEventLine: ask-failed reads as prose, carrying the real error", () => {
  const line = formatEventLine({
    occurredAt: "t0",
    taskId: "x",
    name: "ask-failed",
    details: { error: "the brain is unreachable" },
  });
  assert.equal(line, "t0  ask-failed  ask failed: the brain is unreachable");
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

function heartbeat(occurredAt: string, attempt = 1): FabricaEvent {
  return { occurredAt, taskId: "x", name: "heartbeat", details: { attempt } };
}

test("formatEventLines: a consecutive run of heartbeats collapses into one line with a real span", () => {
  const events: FabricaEvent[] = [
    { occurredAt: "2026-01-01T00:00:00.000Z", taskId: "x", name: "work-started", details: { project: "/repo" } },
    heartbeat("2026-01-01T00:00:15.000Z"),
    heartbeat("2026-01-01T00:00:30.000Z"),
    heartbeat("2026-01-01T00:00:45.000Z"),
    { occurredAt: "2026-01-01T00:00:50.000Z", taskId: "x", name: "check-run", details: { attempt: 1, green: true } },
  ];

  const lines = formatEventLines(events);

  assert.equal(lines.length, 3, `heartbeats should collapse to one line, got: ${JSON.stringify(lines)}`);
  assert.equal(lines[0], "2026-01-01T00:00:00.000Z  work-started  work started on /repo");
  assert.equal(lines[1], "2026-01-01T00:00:15.000Z  heartbeat  3 heartbeats over 30s");
  assert.equal(lines[2], "2026-01-01T00:00:50.000Z  check-run  check finished (attempt 1): green");
});

test("formatEventLines: a single isolated heartbeat reads as an ordinary heartbeat line, not a run of one", () => {
  const events: FabricaEvent[] = [heartbeat("2026-01-01T00:00:15.000Z", 2)];
  const lines = formatEventLines(events);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], "2026-01-01T00:00:15.000Z  heartbeat  heartbeat (attempt 2)");
  assert.doesNotMatch(lines[0], /heartbeats over/);
});

test("formatEventLines: two separate single-heartbeat gaps, split by a real event, don't merge", () => {
  const events: FabricaEvent[] = [
    heartbeat("2026-01-01T00:00:00.000Z"),
    { occurredAt: "2026-01-01T00:00:05.000Z", taskId: "x", name: "check-run", details: { attempt: 1, green: false } },
    heartbeat("2026-01-01T00:00:20.000Z"),
  ];
  const lines = formatEventLines(events);
  assert.equal(lines.length, 3);
  assert.doesNotMatch(lines[0], /heartbeats over/);
  assert.doesNotMatch(lines[2], /heartbeats over/);
});

test("formatEventLines: no events, no lines", () => {
  assert.deepEqual(formatEventLines([]), []);
});

// A task whose brain.ask() threw records "ask-failed", which stateOf
// reports as "failed" - but it never delivered anything, so recordVerdict
// refuses `fabrica verdict <id> fix` with "not-delivered". The notice must
// never point the Client at a command the tool will reject.
test("formatTerminalNotice: a failure with no delivery offers no fix path", () => {
  const notice = formatTerminalNotice("failed", { taskId: "t1", hasDelivery: false });
  assert.ok(notice);
  assert.match(notice, /no `fix` path/);
  assert.match(notice, /fabrica log t1/);
  assert.doesNotMatch(notice, /verdict wakes the worker/);
});

test("formatTerminalNotice: a failed delivery still names the fix path", () => {
  const notice = formatTerminalNotice("failed", { taskId: "t1", hasDelivery: true });
  assert.ok(notice);
  assert.match(notice, /`fix` verdict wakes the worker again/);
});

test("formatTerminalNotice: only terminal-ish states get one", () => {
  const ctx = { taskId: "t1", hasDelivery: true };
  assert.match(formatTerminalNotice("delivered", ctx)!, /task delivered/);
  assert.match(formatTerminalNotice("closed", ctx)!, /task closed/);
  assert.match(formatTerminalNotice("asking", ctx)!, /fabrica answer t1/);
  assert.equal(formatTerminalNotice("working", ctx), null);
  assert.equal(formatTerminalNotice("checking", ctx), null);
});
