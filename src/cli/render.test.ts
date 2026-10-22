import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHECKING_QUIET_CEILING_MS,
  DETAIL_CHAR_LIMIT,
  PRE_WORK_QUIET_CEILING_MS,
  QUIET_THRESHOLD_MS,
  WORKER_LIVENESS_UNKNOWN_NOTICE,
  checkStartedAt,
  describeLiveness,
  expectsWorkerProcess,
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
  wrapDetail,
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

// The base-standing mark (behind origin's default tip): formatStatusLine
// shows `describeBaseStanding`'s string verbatim and never words it
// itself, for the same reason it stopped deciding liveness wording - the
// live view shows the identical string from the identical function.
test("formatStatusLine: shows the base-standing mark verbatim on a delivered task, before the pull request link", () => {
  const line = formatStatusLine(
    { id: "t1", state: "delivered" },
    {
      project: "/proj",
      ageMs: 60_000,
      liveness: null,
      hasDelivery: true,
      baseStanding: "behind origin/main, a fix will rebase (origin last fetched 12m ago)",
      prUrl: "https://example.test/pr/1",
    }
  );
  assert.match(line, /AWAITING YOUR VERDICT/);
  assert.match(line, /behind origin\/main, a fix will rebase \(origin last fetched 12m ago\)/);
  assert.ok(
    line.indexOf("behind origin/main") < line.indexOf("https://example.test/pr/1"),
    `the mark belongs with the verdict, before the link: ${line}`
  );
});

test("formatStatusLine: a base standing of null marks nothing at all", () => {
  const line = formatStatusLine(
    { id: "t1", state: "delivered" },
    { project: "/proj", ageMs: 60_000, liveness: null, hasDelivery: true, baseStanding: null }
  );
  assert.match(line, /AWAITING YOUR VERDICT: fabrica verdict t1 accept\|fix\|wrong$/);
});

test("formatStatusLine: a meter-paused delivery carries the base-standing mark too", () => {
  const line = formatStatusLine(
    { id: "t1", state: "delivered" },
    {
      project: "/proj",
      ageMs: 60_000,
      liveness: null,
      hasDelivery: true,
      pausedByMeter: "the week is 91% full",
      baseStanding: "base unknown: the branch fabrica/t1 is gone from /proj",
    }
  );
  assert.match(line, /PAUSED BY THE SUBSCRIPTION METER/);
  assert.match(line, /base unknown: the branch fabrica\/t1 is gone from \/proj/);
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

// An Inspector refusal with a real delivery behind it is no longer a dead
// end: `fabrica verdict <id> fix` runs the worker again with the refusal's
// own reason as its correction (src/foreman/verdict.ts), so the line has
// to name that instead of pointing the Client at `fabrica log` and
// nothing else.
test("formatStatusLine: a refusal with a delivery behind it names the fix verdict that clears it", () => {
  const line = formatStatusLine(
    { id: "t1", state: "refused" },
    { project: "/proj", ageMs: 600_000, liveness: "Inspector reached no verdict", hasDelivery: true }
  );
  assert.match(line, /INSPECTOR REACHED NO VERDICT/);
  assert.match(line, /`fabrica verdict t1 fix` runs the worker again with the refusal as its correction/);
  assert.match(line, /accept\|wrong rule on the last delivery/);
});

test("formatStatusLine: a refusal with no delivery behind it still names wrong as the only way out", () => {
  const line = formatStatusLine(
    { id: "t1", state: "refused" },
    {
      project: "/proj",
      ageMs: 600_000,
      liveness: "Inspector reached no verdict",
      hasDelivery: false,
      refusalReason: "GITHUB_TOKEN is missing",
    }
  );
  assert.match(line, /GITHUB_TOKEN is missing/);
  assert.match(line, /`fabrica verdict t1 wrong` closes it/);
  assert.doesNotMatch(line, /fix`/);
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

test("describeLiveness: an Inspector refusal says no verdict was reached, never that the task is quiet", () => {
  const start = 1_000_000;
  const events: FabricaEvent[] = [
    {
      occurredAt: new Date(start).toISOString(),
      taskId: "t1",
      name: "inspection-finished",
      details: { verdict: "refused", report: "container runtime unavailable" },
    },
  ];

  assert.equal(describeLiveness("refused", events, start + PRE_WORK_QUIET_CEILING_MS * 10), "Inspector reached no verdict");
  assert.equal(isQuietTooLong("refused", events, start + PRE_WORK_QUIET_CEILING_MS * 10), false);
});

// Issue #99: which tasks `status`/`watch` may go looking for a process
// for. The expensive mistake in both directions - never looking (the
// record-only guessing this issue removes) and looking at a task whose
// worker exited for a perfectly good reason (a confident false alarm on
// every finished task) - is decided here, once.

test("expectsWorkerProcess: a working task whose work has started has a process to look for", () => {
  const events: FabricaEvent[] = [
    { occurredAt: "t0", taskId: "t1", name: "task-received" },
    { occurredAt: "t1", taskId: "t1", name: "work-started" },
    { occurredAt: "t2", taskId: "t1", name: "heartbeat" },
  ];
  assert.equal(expectsWorkerProcess("working", events), true);
});

test("expectsWorkerProcess: a checking task has one too - the check runs inside that same process's round", () => {
  const events: FabricaEvent[] = [
    { occurredAt: "t0", taskId: "t1", name: "work-started" },
    { occurredAt: "t1", taskId: "t1", name: "check-run", details: { attempt: 1, phase: "started" } },
  ];
  assert.equal(expectsWorkerProcess("checking", events), true);
});

test("expectsWorkerProcess: a task before work-started is not judged at all", () => {
  // Client ruling: the pre-work window (brain.ask(), then cutting the
  // line) has its own quiet ceiling and no process reading to add.
  const events: FabricaEvent[] = [{ occurredAt: "t0", taskId: "t1", name: "task-received" }];
  assert.equal(expectsWorkerProcess("working", events), false);
});

test("expectsWorkerProcess: no state where the round has ended or stopped is judged", () => {
  const events: FabricaEvent[] = [
    { occurredAt: "t0", taskId: "t1", name: "work-started" },
    { occurredAt: "t1", taskId: "t1", name: "delivered" },
  ];
  for (const state of ["delivered", "closed", "asking", "failed", "refused", "stopped"] as const) {
    assert.equal(expectsWorkerProcess(state, events), false, `${state} has no worker process to expect`);
  }
});

test("expectsWorkerProcess: false in the window between a `fix` verdict and its round's work-started", () => {
  // The exact false alarm this guard exists for: `fabrica verdict <id>
  // fix` records the ruling in the foreground and hands the round to a
  // detached process, so for a moment the task reads as "working" while
  // the pid file still names the PREVIOUS round's long-exited process.
  const events: FabricaEvent[] = [
    { occurredAt: "t0", taskId: "t1", name: "work-started" },
    { occurredAt: "t1", taskId: "t1", name: "delivered" },
    { occurredAt: "t2", taskId: "t1", name: "verdict-recorded", details: { ruling: "fix", note: "use staging" } },
  ];
  assert.equal(expectsWorkerProcess("working", events), false);

  // ...and true again the moment that round really starts.
  const started: FabricaEvent[] = [...events, { occurredAt: "t3", taskId: "t1", name: "work-started" }];
  assert.equal(expectsWorkerProcess("working", started), true);
});

test("expectsWorkerProcess: false in the same window after `fabrica answer`, before the resumed round starts", () => {
  const events: FabricaEvent[] = [
    { occurredAt: "t0", taskId: "t1", name: "task-received" },
    { occurredAt: "t1", taskId: "t1", name: "questions-asked", details: { questions: ["which database?"] } },
    { occurredAt: "t2", taskId: "t1", name: "answers-given", details: { answer: "postgres" } },
  ];
  assert.equal(expectsWorkerProcess("working", events), false);
});

// Issue #99's whole point: a verified reading of the worker's own
// process replaces the record-only sentence that cannot tell a slow
// worker from a dead one.

test("describeLiveness: a worker that isn't running says so plainly, in place of the quiet notice", () => {
  const start = 1_000_000;
  const events: FabricaEvent[] = [
    { occurredAt: new Date(start).toISOString(), taskId: "t1", name: "work-started" },
    { occurredAt: new Date(start + 1_000).toISOString(), taskId: "t1", name: "heartbeat" },
  ];

  const notice = describeLiveness("working", events, start + 1_000 + QUIET_THRESHOLD_MS + 1, "not-found");

  assert.match(notice!, /^worker process not found/);
  assert.doesNotMatch(notice!, /not known to be stuck/, "there is nothing left unknown about this one");
});

test("describeLiveness: a worker that isn't running is reported before any quiet threshold is reached", () => {
  // A dead worker is a fact the moment it is observed - waiting out
  // QUIET_THRESHOLD_MS first would be the record-only guessing again.
  const start = 1_000_000;
  const events: FabricaEvent[] = [
    { occurredAt: new Date(start).toISOString(), taskId: "t1", name: "work-started" },
    { occurredAt: new Date(start).toISOString(), taskId: "t1", name: "heartbeat" },
  ];

  const notice = describeLiveness("working", events, start + 1_000, "not-found");

  assert.match(notice!, /^worker process not found/);
  assert.equal(isQuietTooLong("working", events, start + 1_000), false, "nothing about the record looks wrong yet");
});

test("describeLiveness: a dead worker mid-check never claims the check finished, and never says it's still running", () => {
  const start = 1_000_000;
  const events: FabricaEvent[] = [
    { occurredAt: new Date(start).toISOString(), taskId: "t1", name: "work-started" },
    {
      occurredAt: new Date(start + 1_000).toISOString(),
      taskId: "t1",
      name: "check-run",
      details: { attempt: 1, phase: "started" },
    },
  ];

  const notice = describeLiveness("checking", events, start + 120_000, "not-found");

  assert.match(notice!, /^worker process not found/);
  assert.doesNotMatch(notice!, /so far/, "the check is not running - nothing is");
  assert.doesNotMatch(notice!, /check finished/, "and it never finished either");
});

test("describeLiveness: an unverifiable worker caveats the record's own account rather than replacing it", () => {
  const start = 1_000_000;
  const events: FabricaEvent[] = [
    { occurredAt: new Date(start).toISOString(), taskId: "t1", name: "work-started" },
    { occurredAt: new Date(start + 1_000).toISOString(), taskId: "t1", name: "heartbeat" },
  ];

  const notice = describeLiveness("working", events, start + 1_000 + QUIET_THRESHOLD_MS + 1, "unknown");

  assert.match(notice!, /^quiet /, "the record is still the best account available");
  assert.ok(notice!.endsWith(WORKER_LIVENESS_UNKNOWN_NOTICE), `expected the unknown caveat, got: ${notice}`);
});

test("describeLiveness: an unverifiable worker with nothing else to report is the caveat alone", () => {
  const start = 1_000_000;
  const events: FabricaEvent[] = [
    { occurredAt: new Date(start).toISOString(), taskId: "t1", name: "work-started" },
    { occurredAt: new Date(start).toISOString(), taskId: "t1", name: "heartbeat" },
  ];

  assert.equal(describeLiveness("working", events, start + 1_000, "unknown"), WORKER_LIVENESS_UNKNOWN_NOTICE);
});

test("describeLiveness: a confirmed-alive worker adds nothing - a healthy task's line stays as it was", () => {
  const start = 1_000_000;
  const events: FabricaEvent[] = [
    { occurredAt: new Date(start).toISOString(), taskId: "t1", name: "work-started" },
    { occurredAt: new Date(start).toISOString(), taskId: "t1", name: "heartbeat" },
  ];

  assert.equal(describeLiveness("working", events, start + 1_000, "alive"), null);
  assert.equal(
    describeLiveness("working", events, start + QUIET_THRESHOLD_MS + 1, "alive"),
    describeLiveness("working", events, start + QUIET_THRESHOLD_MS + 1),
    "a live worker gone quiet still gets the record's own quiet notice, unchanged"
  );
});

test("describeLiveness: an Inspector refusal is unmoved by any process reading - its round really is over", () => {
  const start = 1_000_000;
  const events: FabricaEvent[] = [
    {
      occurredAt: new Date(start).toISOString(),
      taskId: "t1",
      name: "inspection-finished",
      details: { verdict: "refused", report: "container runtime unavailable" },
    },
  ];

  for (const worker of ["alive", "not-found", "unknown"] as const) {
    assert.equal(describeLiveness("refused", events, start + QUIET_THRESHOLD_MS * 10, worker), "Inspector reached no verdict");
  }
});

test("isDeadEnd: a failed task with no delivery is a dead end", () => {
  assert.equal(isDeadEnd("failed", false), true);
});

test("isDeadEnd: a failed task WITH a delivery is not a dead end - a fix verdict can still wake it", () => {
  assert.equal(isDeadEnd("failed", true), false);
});

// Both still true, and deliberately: this function answers "can this
// task's CURRENT ROUND move again by itself", which a refusal's cannot
// either way - it is what keeps the quiet alarm off a round that really
// has ended, and what stops `watch` polling forever. Whether the *task*
// can move is the Client's ruling, which the notices above now name
// separately for each case (`fix` with a delivery behind it, `wrong`
// without).
test("isDeadEnd: an Inspector refusal ends its round, regardless of an earlier delivery", () => {
  assert.equal(isDeadEnd("refused", false), true);
  assert.equal(isDeadEnd("refused", true), true);
});

test("isDeadEnd: all other states are not dead ends", () => {
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

test("formatEventLine: Inspector events name the handoff and report the verdict", () => {
  const called = formatEventLine({
    occurredAt: "t0",
    taskId: "x",
    name: "inspector-called",
    details: { branch: "fabrica/x" },
  });
  const refused = formatEventLine({
    occurredAt: "t1",
    taskId: "x",
    name: "inspection-finished",
    details: { verdict: "refused", report: "GITHUB_TOKEN is missing" },
  });

  assert.equal(called, "t0  inspector-called  Inspector called for fabrica/x");
  assert.equal(refused, "t1  inspection-finished  Inspector refused: GITHUB_TOKEN is missing");
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
      outcome: "done",
      delivery: {
        confidence: 100,
        summary: "done",
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

// Issue #169: `fabrica log` used to cap every rendered detail at a flat
// 200 characters and trail off into an ellipsis, which cut real failure
// messages off mid-sentence and hid the cause the Client opened the log
// to read. A long message is now shown whole; only a genuinely huge
// payload is shortened, and it says so.

test("formatEventLine: a long failure message is shown whole, not cut off mid-sentence", () => {
  const message =
    "Could not reopen the ProductionLine for fabrica/20261014-t-aa from /Users/o/proj: " +
    "git worktree add failed: fatal: 'fabrica/20261014-t-aa' is already used by worktree " +
    "at '/Users/o/.fabrica/work/20261014-t-aa'";
  const line = formatEventLine({ occurredAt: "t0", taskId: "x", name: "task-failed", details: { message } });

  assert.ok(line.includes(message), `the whole message should survive, got: ${line}`);
  assert.doesNotMatch(line, /…/);
});

test("formatEventLine: a payload nobody anticipated is still rendered in full while it is merely long", () => {
  const line = formatEventLine({
    occurredAt: "t0",
    taskId: "x",
    name: "cap-refused",
    details: { reason: "x".repeat(1000) },
  });
  // 1000 characters is a long message, not a huge payload - the old
  // 200-character cap treated the two as the same thing.
  assert.ok(line.includes("x".repeat(1000)), "a merely long payload should not be shortened");
  assert.doesNotMatch(line, /shortened/);
});

test("formatEventLine: a genuinely huge payload is shortened, and the line says so with the real figures", () => {
  const huge = "y".repeat(DETAIL_CHAR_LIMIT * 3);
  const line = formatEventLine({ occurredAt: "t0", taskId: "x", name: "task-failed", details: { message: huge } });

  assert.ok(line.length < huge.length, "a huge payload must not be printed whole");
  // The figures, not a bare ellipsis: a reader who can't tell "the
  // message ended" from "the message was cut" is back to the bug.
  const note = line.match(/\[shortened: (\d+) of (\d+) characters shown\]$/);
  assert.ok(note, `expected a note naming what was dropped, got: ...${line.slice(-120)}`);
  assert.equal(Number(note[1]), DETAIL_CHAR_LIMIT);
  assert.equal(Number(note[2]), huge.length);
});

test("formatEventLine: a message with its own newlines keeps them, each continuation line indented under its event", () => {
  const lines = formatEventLines([
    {
      occurredAt: "t0",
      taskId: "x",
      name: "task-failed",
      details: { message: "git worktree add failed:\nfatal: branch already checked out\nhint: use --force" },
    },
  ]);

  assert.deepEqual(lines, [
    "t0  task-failed  git worktree add failed:",
    "    fatal: branch already checked out",
    "    hint: use --force",
  ]);
});

test("formatEventLines: one array element per output line, so a caller can print it line by line", () => {
  const lines = formatEventLines(
    [{ occurredAt: "t0", taskId: "x", name: "task-failed", details: { message: "a".repeat(200) } }],
    { wrapWidth: 60 }
  );

  assert.ok(lines.length > 1, `expected the message to wrap, got ${lines.length} line(s)`);
  for (const line of lines) assert.ok(line.length <= 60, `line over the width: ${line.length} chars`);
  assert.equal(lines.slice(1).every((line) => line.startsWith("    ")), true);
  assert.equal(lines.join("").replace(/\s/g, ""), `t0task-failed${"a".repeat(200)}`);
});

test("formatEventLine: no wrap width means no reflowing at all - piped output must not depend on a window's size", () => {
  const message = "b".repeat(500);
  const line = formatEventLine({ occurredAt: "t0", taskId: "x", name: "task-failed", details: { message } });
  assert.equal(line, `t0  task-failed  ${message}`);
});

test("wrapDetail: breaks at whitespace, and hard at the margin only for a token wider than the line", () => {
  assert.deepEqual(wrapDetail("the quick brown fox jumps over the lazy dog", 24, 24), [
    "the quick brown fox",
    "jumps over the lazy dog",
  ]);
  // A URL longer than the whole line has nowhere to break: cutting it at
  // the margin beats running off the edge of the window.
  assert.deepEqual(wrapDetail("see https://example.com/a/very/long/path", 24, 24), [
    "see",
    "https://example.com/a/ve",
    "ry/long/path",
  ]);
});

test("wrapDetail: a width narrower than anything readable still makes progress rather than hanging", () => {
  const lines = wrapDetail("c".repeat(100), 1, 1);
  assert.equal(lines.join(""), "c".repeat(100));
  assert.ok(lines.length < 10, `a floor on the segment width should keep this short, got ${lines.length} lines`);
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

// Same split as the status line above: the refusal is the loop's to
// clear when a delivery sits behind it, and only "wrong"'s to close when
// none does. The old notice told the Client to resolve it himself and
// hand the branch over again - advice `fabrica verdict <id> fix` has
// replaced.
test("formatTerminalNotice: a refusal with a delivery behind it names the fix verdict, not hand-resolution", () => {
  const notice = formatTerminalNotice("refused", { taskId: "t1", hasDelivery: true });
  assert.ok(notice);
  assert.match(notice, /fabrica verdict t1 fix/);
  assert.match(notice, /accept\|wrong rule on the last delivery/);
});

test("formatTerminalNotice: a refusal with nothing delivered points at wrong only", () => {
  const notice = formatTerminalNotice("refused", { taskId: "t1", hasDelivery: false });
  assert.ok(notice);
  assert.match(notice, /nothing to fix/);
  assert.match(notice, /fabrica verdict t1 wrong` closes it/);
  assert.doesNotMatch(notice, /verdict t1 fix/);
});

test("formatTerminalNotice: only terminal-ish states get one", () => {
  const ctx = { taskId: "t1", hasDelivery: true };
  assert.match(formatTerminalNotice("delivered", ctx)!, /task delivered/);
  assert.match(formatTerminalNotice("closed", ctx)!, /task closed/);
  assert.match(formatTerminalNotice("asking", ctx)!, /fabrica answer t1/);
  assert.match(formatTerminalNotice("refused", ctx)!, /Inspector reached no verdict/);
  assert.equal(formatTerminalNotice("working", ctx), null);
  assert.equal(formatTerminalNotice("checking", ctx), null);
});

test("formatEventLine: a check the worker's box could not run reads as not run, never as red", () => {
  const line = formatEventLine({
    occurredAt: "t0",
    taskId: "x",
    name: "check-run",
    details: { attempt: 1, notVerified: "the box has no command the check needs (./check.sh -> exit 127)\nsh: npm: not found" },
  });
  assert.match(line, /check could not run \(attempt 1\): the box has no command the check needs/);
  assert.doesNotMatch(line, /red/);
});
