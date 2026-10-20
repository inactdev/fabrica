// Issue #189's pause rule: the thresholds, the readings, and the two
// decisions made from them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, readEventsForTask } from "../record/index.ts";
import { ForemanError } from "./errors.ts";
import {
  describeMeters,
  formatPercent,
  latestMeterReading,
  meterPauseOf,
  meterReadingFromTranscript,
  METER_READING_MAX_AGE_MS,
  pauseRuleFor,
  refusalFor,
  requireMeterRoomToStart,
  standingOf,
  stopFor,
} from "./meters.ts";
import { DEFAULT_PAUSE_RULE } from "../config/index.ts";
import type { MeterReading } from "../brain/index.ts";
import type { Receipt } from "../inspector/types.ts";

const NOW = Date.parse("2026-10-20T12:00:00.000Z");

function home(projectsToml?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-meters-"));
  if (projectsToml !== undefined) writeFileSync(join(dir, "projects.toml"), projectsToml);
  return dir;
}

function reading(fiveHourPercent: number | null, sevenDayPercent: number | null, atMs = NOW): MeterReading {
  return { observedAt: new Date(atMs).toISOString(), fiveHourPercent, sevenDayPercent };
}

/** A receipt carrying one reading - the only place a reading ever lands
 * on the record (issue #189: "every receipt records the two meters"). */
function receiptWith(task: string, attempt: number, meters: MeterReading | null): Receipt {
  return {
    task,
    attempt,
    brain: "fake",
    model: "fake-1",
    startedAt: new Date(NOW).toISOString(),
    durationMs: 1,
    costUsd: 0,
    costUnknown: false,
    costBasis: "subscription-estimate",
    meters,
    session: null,
    reasoningEffort: null,
    checks: null,
    outcome: "delivered",
  };
}

test("standingOf: a missing reading, a reading with neither meter, and a stale one are all unknown", () => {
  assert.equal(standingOf(null, NOW).usable, false);
  assert.equal(standingOf(undefined, NOW).usable, false);
  assert.equal(standingOf(reading(null, null), NOW).usable, false);
  assert.equal(standingOf(reading(10, 20, NOW - METER_READING_MAX_AGE_MS - 1), NOW).usable, false);
  for (const standing of [standingOf(null, NOW), standingOf(reading(null, null), NOW)]) {
    assert.ok(standing.unknownBecause, "an unusable reading always says why");
  }
});

test("standingOf: a fresh reading with one meter is usable - a provider that reports one window is not useless", () => {
  assert.equal(standingOf(reading(null, 64), NOW).usable, true);
  assert.equal(standingOf(reading(7, null), NOW).usable, true);
  assert.equal(standingOf(reading(7, 64, NOW - METER_READING_MAX_AGE_MS + 1_000), NOW).usable, true);
});

test("refusalFor: above 70% of the week refuses a new start, at exactly 70 does not", () => {
  const over = refusalFor(standingOf(reading(5, 70.5), NOW), DEFAULT_PAUSE_RULE);
  assert.equal(over?.meter, "seven-day");
  assert.equal(over?.thresholdPercent, 70);
  assert.match(over!.message, /70.5% of the 7-day window/);
  assert.match(over!.message, /Nothing was started/);

  assert.equal(refusalFor(standingOf(reading(5, 70), NOW), DEFAULT_PAUSE_RULE), undefined);
  assert.equal(refusalFor(standingOf(reading(5, 12), NOW), DEFAULT_PAUSE_RULE), undefined);
});

test("refusalFor: the 5-hour window refuses only above 90, and the week is named first when both are over", () => {
  assert.equal(refusalFor(standingOf(reading(85, 10), NOW), DEFAULT_PAUSE_RULE), undefined);
  assert.equal(refusalFor(standingOf(reading(95, 10), NOW), DEFAULT_PAUSE_RULE)?.meter, "five-hour");
  assert.equal(refusalFor(standingOf(reading(95, 95), NOW), DEFAULT_PAUSE_RULE)?.meter, "seven-day");
});

test("refusalFor: an unusable reading refuses nothing at all - the rule fails open", () => {
  assert.equal(refusalFor(standingOf(null, NOW), DEFAULT_PAUSE_RULE), undefined);
  assert.equal(refusalFor(standingOf(reading(99, 99, NOW - METER_READING_MAX_AGE_MS - 1), NOW), DEFAULT_PAUSE_RULE), undefined);
});

test("stopFor: only the week stops work in flight - a full 5-hour window never does", () => {
  assert.equal(stopFor(standingOf(reading(5, 91), NOW), DEFAULT_PAUSE_RULE)?.thresholdPercent, 90);
  assert.equal(stopFor(standingOf(reading(5, 90), NOW), DEFAULT_PAUSE_RULE), undefined);
  assert.equal(stopFor(standingOf(reading(100, 50), NOW), DEFAULT_PAUSE_RULE), undefined);
  assert.equal(stopFor(standingOf(null, NOW), DEFAULT_PAUSE_RULE), undefined);
});

test("meterReadingFromTranscript: the last meters entry wins, and an unreadable one is no reading", () => {
  const entries = [
    { kind: "text", text: "hello" },
    { kind: "meters", text: JSON.stringify(reading(1, 2)) },
    { kind: "meters", text: JSON.stringify(reading(7, 64)) },
  ];
  assert.deepEqual(meterReadingFromTranscript(entries), reading(7, 64));

  assert.equal(meterReadingFromTranscript([{ kind: "meters", text: "{not json" }]), null);
  assert.equal(meterReadingFromTranscript([{ kind: "meters", text: JSON.stringify({ fiveHourPercent: 1 }) }]), null);
  assert.equal(meterReadingFromTranscript([{ kind: "text", text: "nothing here" }]), null);
});

test("meterReadingFromTranscript: a meter the brain could not report stays null, never 0", () => {
  const read = meterReadingFromTranscript([
    { kind: "meters", text: JSON.stringify({ observedAt: new Date(NOW).toISOString(), sevenDayPercent: 64 }) },
  ]);
  assert.equal(read?.fiveHourPercent, null);
  assert.equal(read?.sevenDayPercent, 64);
});

test("latestMeterReading: the newest reading across every task, by when it was taken - not by log order", () => {
  const recordHome = home();
  // Appended out of order on purpose: two tasks running at once append
  // their receipts when their attempts END, which has nothing to do with
  // when each reading was taken.
  appendEvent(recordHome, {
    taskId: "task-late-append",
    name: "receipt-recorded",
    details: { receipt: receiptWith("task-late-append", 1, reading(2, 20, NOW - 60_000)) },
  });
  appendEvent(recordHome, {
    taskId: "task-other",
    name: "delivered",
    details: { receipts: [receiptWith("task-other", 1, reading(9, 64, NOW - 30_000))] },
  });
  appendEvent(recordHome, {
    taskId: "task-third",
    name: "receipt-recorded",
    details: { receipt: receiptWith("task-third", 1, reading(1, 10, NOW - 90_000)) },
  });

  const events = [...readEventsForTask(recordHome, "task-late-append"), ...readEventsForTask(recordHome, "task-other"), ...readEventsForTask(recordHome, "task-third")];
  assert.equal(latestMeterReading(events)?.sevenDayPercent, 64);
});

test("latestMeterReading: receipts with no reading at all leave it null, never 0", () => {
  const recordHome = home();
  appendEvent(recordHome, {
    taskId: "task-1",
    name: "receipt-recorded",
    details: { receipt: receiptWith("task-1", 1, null) },
  });
  assert.equal(latestMeterReading(readEventsForTask(recordHome, "task-1")), null);
});

test("pauseRuleFor: no projects.toml still has a pause rule - the defaults", () => {
  assert.deepEqual(pauseRuleFor(home()), DEFAULT_PAUSE_RULE);
});

test("pauseRuleFor: a [pause] table overrides only what it names", () => {
  const rule = pauseRuleFor(home("[pause]\nsevenDayRefusePercent = 40\n"));
  assert.equal(rule.sevenDayRefusePercent, 40);
  assert.equal(rule.sevenDayStopPercent, DEFAULT_PAUSE_RULE.sevenDayStopPercent);
  assert.equal(rule.fiveHourRefusePercent, DEFAULT_PAUSE_RULE.fiveHourRefusePercent);
});

test("requireMeterRoomToStart: refuses above the week's threshold, records why, and names the numbers", () => {
  const recordHome = home("[pause]\nsevenDayRefusePercent = 70\n");
  appendEvent(recordHome, {
    taskId: "task-earlier",
    name: "receipt-recorded",
    details: { receipt: receiptWith("task-earlier", 1, reading(10, 88)) },
  });

  const warnings: string[] = [];
  assert.throws(
    () => requireMeterRoomToStart(recordHome, "task-new", { project: "/repos/demo", now: NOW, warn: (l) => warnings.push(l) }),
    (err: unknown) => {
      assert.ok(err instanceof ForemanError);
      assert.equal(err.code, "meter-refused");
      assert.match(err.message, /88% of the 7-day window/);
      return true;
    }
  );
  assert.deepEqual(warnings, [], "a real refusal is recorded, not warned about");

  const refusal = readEventsForTask(recordHome, "task-new").find((e) => e.name === "meter-refused");
  assert.ok(refusal, "the refusal lands on the refused task's own record");
  const details = refusal!.details as { meter: string; usedPercent: number; thresholdPercent: number; project?: string };
  assert.equal(details.meter, "seven-day");
  assert.equal(details.usedPercent, 88);
  assert.equal(details.thresholdPercent, 70);
  assert.equal(details.project, "/repos/demo");
});

test("requireMeterRoomToStart: an unknown reading refuses nothing and says so on stderr", () => {
  const recordHome = home();
  const warnings: string[] = [];
  requireMeterRoomToStart(recordHome, "task-new", { now: NOW, warn: (l) => warnings.push(l) });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unknown/);
  assert.match(warnings[0], /Nothing was refused on an unread number/);
  assert.equal(
    readEventsForTask(recordHome, "task-new").filter((e) => e.name === "meter-refused").length,
    0,
    "nothing is recorded when nothing was refused"
  );
});

test("requireMeterRoomToStart: a stale reading is unknown too, however alarming its numbers", () => {
  const recordHome = home();
  appendEvent(recordHome, {
    taskId: "task-old",
    name: "receipt-recorded",
    details: { receipt: receiptWith("task-old", 1, reading(99, 99, NOW - METER_READING_MAX_AGE_MS - 1)) },
  });
  const warnings: string[] = [];
  requireMeterRoomToStart(recordHome, "task-new", { now: NOW, warn: (l) => warnings.push(l) });
  assert.match(warnings[0] ?? "", /too stale/);
});

test("requireMeterRoomToStart: a raised threshold in projects.toml lets the same reading through", () => {
  const recordHome = home("[pause]\nsevenDayRefusePercent = 95\nsevenDayStopPercent = 99\n");
  appendEvent(recordHome, {
    taskId: "task-earlier",
    name: "receipt-recorded",
    details: { receipt: receiptWith("task-earlier", 1, reading(10, 88)) },
  });
  requireMeterRoomToStart(recordHome, "task-new", { now: NOW, warn: () => {} });
});

test("meterPauseOf: reports a paused round, and stops once the Client's fix verdict moves it on", () => {
  const recordHome = home();
  appendEvent(recordHome, {
    taskId: "task-1",
    name: "meter-paused",
    details: {
      attempt: 1,
      usedPercent: 93,
      thresholdPercent: 90,
      observedAt: new Date(NOW).toISOString(),
      message: "Paused by the subscription meter: 93% of the 7-day window is used",
      workerStopped: true,
    },
  });
  assert.equal(meterPauseOf(recordHome, "task-1")?.usedPercent, 93);

  appendEvent(recordHome, { taskId: "task-1", name: "verdict-recorded", details: { ruling: "fix" } });
  assert.equal(meterPauseOf(recordHome, "task-1"), undefined, "a fix verdict means the task is moving again");
});

test("describeMeters and formatPercent word both meters for a person, and never invent a number", () => {
  assert.equal(describeMeters(standingOf(reading(7, 64), NOW)), "5h 7%, 7d 64%");
  assert.equal(describeMeters(standingOf(reading(null, 64), NOW)), "5h unknown, 7d 64%");
  assert.equal(describeMeters(standingOf(null, NOW)), "not read yet");
  assert.equal(formatPercent(64), "64%");
  assert.equal(formatPercent(63.6999), "63.7%");
});
