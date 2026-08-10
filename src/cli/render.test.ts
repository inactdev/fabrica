import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHECKING_QUIET_CEILING_MS,
  PRE_WORK_QUIET_CEILING_MS,
  QUIET_THRESHOLD_MS,
  checkStartedAt,
  describeLiveness,
  formatAge,
  formatCheckingQuietNotice,
  formatEventLine,
  formatEventLines,
  formatQuietNotice,
  formatStatusLine,
  formatTerminalNotice,
  formatTranscriptLine,
  isDeadEnd,
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

test("isQuietTooLong: false for the pre-work ask() window well within its own ceiling - it has a known explanation too", () => {
  const start = 1_000_000;
  // Only "task-received" so far: stateOf reports "working" (its default),
  // but no "work-started" has landed - this is brain.ask()'s window, not
  // a worker gone silent.
  const events: FabricaEvent[] = [{ occurredAt: new Date(start).toISOString(), taskId: "x", name: "task-received" }];
  assert.equal(isQuietTooLong("working", events, start + QUIET_THRESHOLD_MS), false);
});

// Client ruling, issue #12 review finding (the pre-work window's own
// twin of the checking ceiling): "no state may be exempt forever" - past
// PRE_WORK_QUIET_CEILING_MS, a task stuck between task-received and
// work-started becomes eligible for the alarm too, catching a reboot or
// OOM during brain.ask() that would otherwise freeze the record here
// with the alarm never firing.
test("isQuietTooLong: false right up to PRE_WORK_QUIET_CEILING_MS, true just past it, for the pre-work window", () => {
  const start = 1_000_000;
  const events: FabricaEvent[] = [{ occurredAt: new Date(start).toISOString(), taskId: "x", name: "task-received" }];
  assert.equal(isQuietTooLong("working", events, start + PRE_WORK_QUIET_CEILING_MS - 1), false);
  assert.equal(isQuietTooLong("working", events, start + PRE_WORK_QUIET_CEILING_MS + 1), true);
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

// formatStatusLine itself only ever decides three things now: the
// delivered flag, the dead-end flag, and whether to append whatever
// `describeLiveness` decided - it no longer picks checking/quiet
// wording itself (issue #12 review finding: that decision, and the
// elapsed-time arithmetic under it, used to live here AND be
// independently re-derived in watch-command.ts, and the two copies had
// already drifted apart once). See the `describeLiveness` tests below
// for the wording/quantity coverage that used to live on this function.

test("formatStatusLine: flags a delivered task as awaiting verdict", () => {
  const line = formatStatusLine(
    { id: "t1", state: "delivered" },
    { project: "/proj", ageMs: 60_000, liveness: null, hasDelivery: true }
  );
  assert.match(line, /AWAITING YOUR VERDICT/);
  assert.match(line, /fabrica verdict t1 accept\|fix\|wrong/);
});

test("formatStatusLine: appends whatever describeLiveness decided, verbatim", () => {
  const line = formatStatusLine(
    { id: "t1", state: "working" },
    { project: "/proj", ageMs: 600_000, liveness: "quiet 1m, no signal since last heartbeat - test wording", hasDelivery: false }
  );
  assert.match(line, /quiet 1m, no signal since last heartbeat - test wording/);
});

test("formatStatusLine: no liveness notice, no flag at all", () => {
  const line = formatStatusLine(
    { id: "t1", state: "working" },
    { project: "/proj", ageMs: 5_000, liveness: null, hasDelivery: false }
  );
  assert.doesNotMatch(line, /<-/);
});

test("formatStatusLine: unknown project is said plainly, not left blank", () => {
  const line = formatStatusLine(
    { id: "t1", state: "working" },
    { project: null, ageMs: 1_000, liveness: null, hasDelivery: false }
  );
  assert.match(line, /unknown project/);
});

test("formatStatusLine: a failed task with no delivery is marked FAILED, UNRESOLVABLE, not left looking like open work", () => {
  const line = formatStatusLine(
    { id: "t1", state: "failed" },
    { project: "/proj", ageMs: 600_000, liveness: null, hasDelivery: false }
  );
  assert.match(line, /FAILED, UNRESOLVABLE/);
});

test("formatStatusLine: a failed task WITH a delivery is not marked unresolvable - a fix verdict can still wake it", () => {
  const line = formatStatusLine(
    { id: "t1", state: "failed" },
    { project: "/proj", ageMs: 600_000, liveness: null, hasDelivery: true }
  );
  assert.doesNotMatch(line, /UNRESOLVABLE/);
});

// describeLiveness is the one place `status` and `watch` decide what a
// task's liveness looks like - these tests work from real event arrays
// (not precomputed numbers) so a regression that makes the two commands
// diverge again would have to fail here first, since both now call this
// exact function rather than each deriving their own wording.

test("describeLiveness: a checking task within its ceiling says so plainly with its real elapsed time, never quiet", () => {
  const start = 1_000_000;
  const events: FabricaEvent[] = [
    { occurredAt: new Date(start).toISOString(), taskId: "t1", name: "check-run", details: { attempt: 1, phase: "started" } },
  ];
  const notice = describeLiveness("checking", events, start + 120_000);
  assert.equal(notice, "checking, 2m so far");
});

// Client ruling, issue #12 review finding: once isQuietTooLong has ruled
// a checking task quiet (past CHECKING_QUIET_CEILING_MS), the quiet
// alarm takes over the display instead of the plain elapsed line.
test("describeLiveness: a checking task past its ceiling shows the quiet alarm, not the plain elapsed line", () => {
  const start = 1_000_000;
  const events: FabricaEvent[] = [
    { occurredAt: new Date(start).toISOString(), taskId: "t1", name: "check-run", details: { attempt: 1, phase: "started" } },
  ];
  const notice = describeLiveness("checking", events, start + CHECKING_QUIET_CEILING_MS + 1);
  assert.match(notice ?? "", /not known to be stuck/);
  assert.doesNotMatch(notice ?? "", /checking, .* so far/);
});

// Client ruling, issue #12 review finding: a stuck check's quiet notice
// must name what actually happened (a check that started N ago and has
// not finished) rather than reusing the "no signal since last heartbeat"
// wording - no heartbeat is ever emitted during a check, so that phrase
// would point at a signal that never existed.
test("describeLiveness: a checking task past its ceiling names a check, not a nonexistent heartbeat", () => {
  const start = 1_000_000;
  const events: FabricaEvent[] = [
    { occurredAt: new Date(start).toISOString(), taskId: "t1", name: "check-run", details: { attempt: 1, phase: "started" } },
  ];
  const notice = describeLiveness("checking", events, start + CHECKING_QUIET_CEILING_MS + 1);
  assert.match(notice ?? "", /checking, .* and still not finished/);
  assert.doesNotMatch(notice ?? "", /heartbeat/);
});

// Review finding (fixed once already, now proven against the real
// function both commands share): a heartbeat landing after check-run
// "started" doesn't change stateOf's "checking" verdict, so
// lastActivityAt and checkStartedAt genuinely diverge here - the
// checking notice must read the latter, not the former.
test("describeLiveness: a checking task past its ceiling reports how long the CHECK has run, not time since a later heartbeat", () => {
  const start = 1_000_000;
  const events: FabricaEvent[] = [
    { occurredAt: new Date(start).toISOString(), taskId: "t1", name: "check-run", details: { attempt: 1, phase: "started" } },
    // A heartbeat 4h after the check started - much more recent than
    // the check's own start, but stateOf still reports "checking".
    { occurredAt: new Date(start + 4 * 60 * 60 * 1000).toISOString(), taskId: "t1", name: "heartbeat", details: { attempt: 1 } },
  ];
  const now = start + CHECKING_QUIET_CEILING_MS + 60 * 60 * 1000; // 5h after start
  const notice = describeLiveness("checking", events, now);
  assert.match(notice ?? "", /checking, 5h and still not finished/);
});

test("describeLiveness: an ordinary working task gone quiet, wording names the lost heartbeat", () => {
  const start = 1_000_000;
  const events: FabricaEvent[] = [
    { occurredAt: new Date(start).toISOString(), taskId: "t1", name: "work-started" },
    { occurredAt: new Date(start + 1_000).toISOString(), taskId: "t1", name: "heartbeat", details: { attempt: 1 } },
  ];
  const notice = describeLiveness("working", events, start + 1_000 + QUIET_THRESHOLD_MS + 1);
  assert.match(notice ?? "", /no signal since last heartbeat/);
});

test("describeLiveness: the pre-work window gone quiet, wording names the actual last event, not a heartbeat", () => {
  const start = 1_000_000;
  const events: FabricaEvent[] = [{ occurredAt: new Date(start).toISOString(), taskId: "t1", name: "task-received" }];
  const notice = describeLiveness("working", events, start + PRE_WORK_QUIET_CEILING_MS + 1);
  assert.match(notice ?? "", /no signal since the task was received/);
  assert.doesNotMatch(notice ?? "", /heartbeat/);
});

// Review finding (issue #12, third instance of this exact bug shape):
// the quiet notice used to pair "how long since anything happened"
// (lastActivityAt) with "did a heartbeat ever occur, anywhere in the
// history" (a separate whole-history query) - two independently derived
// facts that could disagree. Both mirror cases from that finding, now
// proven against the real function: a worker killed right after a red
// check-run must say the CHECK finished, not fall back to a stale
// "heartbeat" claim just because one happened earlier in the task's
// life.
test("describeLiveness: mirror case 1 - killed right after a red check-run, names the check finishing, not a stale earlier heartbeat", () => {
  const start = 1_000_000;
  const events: FabricaEvent[] = [
    { occurredAt: new Date(start).toISOString(), taskId: "t1", name: "work-started" },
    // An earlier heartbeat exists in the history - the old hadHeartbeat
    // query would find it and claim it's the last signal, even though
    // it isn't.
    { occurredAt: new Date(start + 1_000).toISOString(), taskId: "t1", name: "heartbeat", details: { attempt: 1 } },
    { occurredAt: new Date(start + 2_000).toISOString(), taskId: "t1", name: "check-run", details: { attempt: 1, phase: "started" } },
    // The check finished red - stateOf falls back to "working" - and
    // then the worker was killed with nothing else ever appended.
    { occurredAt: new Date(start + 5_000).toISOString(), taskId: "t1", name: "check-run", details: { attempt: 1, green: false } },
  ];
  const notice = describeLiveness("working", events, start + 5_000 + QUIET_THRESHOLD_MS + 1);
  assert.match(notice ?? "", /no signal since the check finished/);
  assert.doesNotMatch(notice ?? "", /heartbeat/);
});

// Mirror case 2: a worker killed inside the first heartbeat interval -
// before any heartbeat has ever fired - must say work STARTED, the real
// signal that did land, rather than a vague "nothing recorded" that
// undersells what's actually known.
test("describeLiveness: mirror case 2 - killed before the first heartbeat, names work starting, not a vague 'nothing recorded'", () => {
  const start = 1_000_000;
  const events: FabricaEvent[] = [
    { occurredAt: new Date(start).toISOString(), taskId: "t1", name: "task-received" },
    { occurredAt: new Date(start + 1_000).toISOString(), taskId: "t1", name: "work-started" },
  ];
  const notice = describeLiveness("working", events, start + 1_000 + QUIET_THRESHOLD_MS + 1);
  assert.match(notice ?? "", /no signal since work started/);
  assert.doesNotMatch(notice ?? "", /heartbeat/);
});

test("describeLiveness: null for a plain working task with recent activity - nothing to say", () => {
  const start = 1_000_000;
  const events: FabricaEvent[] = [{ occurredAt: new Date(start).toISOString(), taskId: "t1", name: "work-started" }];
  assert.equal(describeLiveness("working", events, start + 5_000), null);
});

test("describeLiveness: null for a delivered task, no matter how old", () => {
  const events: FabricaEvent[] = [{ occurredAt: "2020-01-01T00:00:00.000Z", taskId: "t1", name: "delivered" }];
  assert.equal(describeLiveness("delivered", events, Date.now()), null);
});

test("describeLiveness: null for a checking task with no recorded start at all (defensive, shouldn't happen for a real task)", () => {
  const events: FabricaEvent[] = [{ occurredAt: "t0", taskId: "t1", name: "task-received" }];
  assert.equal(describeLiveness("checking", events, Date.now() + CHECKING_QUIET_CEILING_MS * 10), null);
});

test("isDeadEnd: a failed task with no delivery is a dead end", () => {
  assert.equal(isDeadEnd("failed", false), true);
});

test("isDeadEnd: a failed task WITH a delivery is not a dead end - a fix verdict can still wake it", () => {
  assert.equal(isDeadEnd("failed", true), false);
});

test("isDeadEnd: any non-failed state is never a dead end, regardless of delivery", () => {
  assert.equal(isDeadEnd("working", false), false);
  assert.equal(isDeadEnd("checking", false), false);
  assert.equal(isDeadEnd("delivered", false), false);
  assert.equal(isDeadEnd("closed", false), false);
  assert.equal(isDeadEnd("asking", false), false);
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

test("formatQuietNotice: names whatever signal it's given, verbatim - it's the one formatStatusLine prints", () => {
  const notice = formatQuietNotice(90_000, "last heartbeat");
  assert.equal(notice, "quiet 1m, no signal since last heartbeat - not known to be stuck, not known to be fine");
  const line = formatStatusLine({ id: "t1", state: "working" }, { project: "/p", ageMs: 600_000, liveness: notice, hasDelivery: false });
  assert.ok(line.endsWith(notice), `status line should end with the shared notice, got: ${line}`);
});

test("formatQuietNotice: assumes nothing about what the signal was - it just prints the label it's given", () => {
  const notice = formatQuietNotice(90_000, "work started");
  assert.equal(notice, "quiet 1m, no signal since work started - not known to be stuck, not known to be fine");
  assert.doesNotMatch(notice, /heartbeat/);
});

test("formatCheckingQuietNotice: names a check that started N ago and hasn't finished, not a heartbeat", () => {
  const notice = formatCheckingQuietNotice(5 * 60 * 60 * 1000);
  assert.equal(notice, "checking, 5h and still not finished - not known to be stuck, not known to be fine");
  assert.doesNotMatch(notice, /heartbeat/);
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
