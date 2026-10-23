// Issue #111: since #108 a task is judged one of two very different ways
// - Inspector's own independent run, or the worker checking itself in its
// own box - and the listing showed both greens identically. These cover
// the reading (`render.ts`'s `checkModeFromEvents`), the words, and the
// two surfaces that show them: `fabrica status`'s delivered line and
// `fabrica log`'s rendering of the event where the mode was decided.
// Rendering only: nothing here adds to the record.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, registerTask } from "../record/index.ts";
import { checkModeFromEvents, describeCheckMode, formatEventLine, formatStatusLine } from "./render.ts";
import { runLogCommand } from "./log-command.ts";
import { runStatusCommand } from "./status-command.ts";
import type { FabricaEvent } from "../index.ts";

function event(name: FabricaEvent["name"], details?: unknown, occurredAt = "2026-10-22T10:00:00.000Z"): FabricaEvent {
  return { occurredAt, taskId: "20261022-t-aa", name, ...(details === undefined ? {} : { details }) };
}

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-cli-check-mode-"));
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
}

const SKIPPED = event("inspection-skipped", { reason: "no .inspector.json at the task base commit" });

test("checkModeFromEvents: a task handed to Inspector reads as Inspector-checked", () => {
  assert.equal(
    checkModeFromEvents([
      event("work-started", { project: "/p" }),
      event("inspector-called", { branch: "fabrica/t1" }),
      event("inspection-finished", { verdict: "green", report: "ok" }),
      event("delivered", { outcome: "done" }),
    ]),
    "inspector"
  );
  // The call alone is enough: a round whose Inspector run never answered
  // was still judged by Inspector, not by the worker.
  assert.equal(checkModeFromEvents([event("inspector-called", { branch: "fabrica/t1" })]), "inspector");
});

test("checkModeFromEvents: no Inspector, but a check really ran in the box, reads as self-tested", () => {
  assert.equal(
    checkModeFromEvents([
      SKIPPED,
      event("work-started", { project: "/p" }),
      event("check-run", { attempt: 1, phase: "started", where: "worker's box" }),
      event("check-run", { attempt: 1, green: true }),
      event("delivered", { outcome: "done" }),
    ]),
    "self-tested"
  );
});

// Client ruling (issue #111 clarification): its own third state. Self-
// tested means a check actually ran - a round that never got that far
// (its write-up was invalid, so `attempts.ts` never called the judge)
// must not borrow the words of one that did.
test("checkModeFromEvents: no Inspector and no check at all is 'not checked', never self-tested", () => {
  assert.equal(
    checkModeFromEvents([SKIPPED, event("work-started", { project: "/p" }), event("delivered", { outcome: "failure-report" })]),
    "not-checked"
  );
});

// The box could not run the check at all (`judge.ts`'s `selfTestJudge`
// records that as a `check-run` with `notVerified`, after that attempt's
// own `"started"` one) - delivered as `not-verified`, which is a
// "delivered" state and so does get a mode line. Nothing checked the
// work, so it must not read as self-tested: the Client's rule is that
// self-tested means a check actually ran.
test("checkModeFromEvents: a check the box could not run is 'not checked', not self-tested", () => {
  assert.equal(
    checkModeFromEvents([
      SKIPPED,
      event("work-started", { project: "/p" }),
      event("check-run", { attempt: 1, phase: "started", where: "worker's box" }),
      event("check-run", { attempt: 1, notVerified: "docker: Cannot connect to the Docker daemon" }),
      event("delivered", { outcome: "not-verified" }),
    ]),
    "not-checked"
  );

  // An earlier attempt that really did run does not rescue it: the round
  // the Client is ruling on ended with nothing verified.
  assert.equal(
    checkModeFromEvents([
      SKIPPED,
      event("check-run", { attempt: 1, green: false }),
      event("check-run", { attempt: 2, phase: "started" }),
      event("check-run", { attempt: 2, notVerified: "the box has no command the check needs" }),
    ]),
    "not-checked"
  );
});

// A check that started and has not finished did run - whether it is
// stuck is the quiet ceiling's question, not this one.
test("checkModeFromEvents: a check still in flight counts as self-tested", () => {
  assert.equal(checkModeFromEvents([SKIPPED, event("check-run", { attempt: 1, phase: "started" })]), "self-tested");
});

test("checkModeFromEvents: a record saying neither reads as unknown, which is still said out loud", () => {
  assert.equal(checkModeFromEvents([event("work-started", { project: "/p" }), event("delivered", { outcome: "done" })]), "unknown");
  assert.equal(checkModeFromEvents([]), "unknown");
  assert.equal(describeCheckMode("unknown"), "check mode unknown");
});

// A `fix` round can be judged in a different mode from the round before
// it (Inspector installed in between, or `.inspector.json` added), so the
// newest signal is the only one still true - the same latest-wins rule
// `projectFromEvents`/`prUrlFromEvents` follow.
test("checkModeFromEvents: the latest round's mode wins, in both directions", () => {
  const selfThenInspector = [
    SKIPPED,
    event("check-run", { attempt: 1, green: true }),
    event("delivered", { outcome: "done" }),
    event("verdict-recorded", { ruling: "fix" }),
    event("inspector-called", { branch: "fabrica/t1" }),
    event("inspection-finished", { verdict: "green", report: "ok" }),
  ];
  assert.equal(checkModeFromEvents(selfThenInspector), "inspector");

  const inspectorThenSelf = [
    event("inspector-called", { branch: "fabrica/t1" }),
    event("inspection-finished", { verdict: "green", report: "ok" }),
    event("delivered", { outcome: "done" }),
    event("verdict-recorded", { ruling: "fix" }),
    SKIPPED,
    event("check-run", { attempt: 1, green: false }),
  ];
  assert.equal(checkModeFromEvents(inspectorThenSelf), "self-tested");
});

// The per-round reset: a check that ran in an earlier round says nothing
// about the round the Client is being asked to rule on now.
test("checkModeFromEvents: a self-tested fix round that never ran a check is 'not checked', despite an earlier one that did", () => {
  assert.equal(
    checkModeFromEvents([
      SKIPPED,
      event("check-run", { attempt: 1, green: true }),
      event("delivered", { outcome: "done" }),
      event("verdict-recorded", { ruling: "fix" }),
      SKIPPED,
      event("delivered", { outcome: "failure-report" }),
    ]),
    "not-checked"
  );
});

test("the status line names the mode on a delivered task, in the fact columns before the verdict call-to-action", () => {
  const inspector = formatStatusLine(
    { id: "20261022-t-aa", state: "delivered" },
    { project: "/p", ageMs: 60_000, liveness: null, hasDelivery: true, checkMode: "inspector" }
  );
  assert.match(inspector, /checked by Inspector/);
  assert.ok(
    inspector.indexOf("checked by Inspector") < inspector.indexOf("AWAITING YOUR VERDICT"),
    `the mode is a fact about the green, not part of the command: ${inspector}`
  );

  const selfTested = formatStatusLine(
    { id: "20261022-t-aa", state: "delivered" },
    { project: "/p", ageMs: 60_000, liveness: null, hasDelivery: true, checkMode: "self-tested" }
  );
  assert.match(selfTested, /self-tested, not independently checked/);
  assert.doesNotMatch(selfTested, /checked by Inspector/);

  const notChecked = formatStatusLine(
    { id: "20261022-t-aa", state: "delivered" },
    { project: "/p", ageMs: 60_000, liveness: null, hasDelivery: true, checkMode: "not-checked" }
  );
  assert.match(notChecked, /not checked - nothing ran/);
});

// Client ruling (issue #111 clarification): never omit the line - a
// missing line looks like nothing to say.
test("a delivered line with no mode behind it says 'check mode unknown' rather than nothing", () => {
  const line = formatStatusLine(
    { id: "20261022-t-aa", state: "delivered" },
    { project: "/p", ageMs: 60_000, liveness: null, hasDelivery: true }
  );
  assert.match(line, /check mode unknown/);
});

test("a meter-paused delivery names its mode too - it is still a delivery awaiting a ruling", () => {
  const line = formatStatusLine(
    { id: "20261022-t-aa", state: "delivered" },
    {
      project: "/p",
      ageMs: 60_000,
      liveness: null,
      hasDelivery: true,
      checkMode: "self-tested",
      pausedByMeter: "the week is 91% full",
    }
  );
  assert.match(line, /self-tested, not independently checked/);
  assert.match(line, /PAUSED BY THE SUBSCRIPTION METER/);
});

// Only the delivered line: that is where a green is being offered for
// acceptance. A working task has no verdict to colour yet.
test("a working task's line says nothing about the mode", () => {
  const line = formatStatusLine(
    { id: "20261022-t-aa", state: "working" },
    { project: "/p", ageMs: 1_000, liveness: null, hasDelivery: false, checkMode: "self-tested" }
  );
  assert.doesNotMatch(line, /check mode|self-tested|checked by Inspector/);
});

test("fabrica log renders inspection-skipped as the round's mode, with its reason, never as a skip", () => {
  const line = formatEventLine(SKIPPED);
  assert.match(line, /check mode: self-tested, not independently checked - no \.inspector\.json at the task base commit/);
  // The name column is the record's own event name (every line in
  // `fabrica log` carries it, and `FabricaEventName` is ratified), so
  // what had to stop reading as a skip is the rendered detail beside it.
  assert.doesNotMatch(line.replace("inspection-skipped", ""), /skipped/);

  const notInstalled = formatEventLine(event("inspection-skipped", { reason: "Inspector is not installed" }));
  assert.match(notInstalled, /check mode: self-tested, not independently checked - Inspector is not installed/);

  // A reason-less event still reads as the mode, not as raw JSON.
  assert.match(formatEventLine(event("inspection-skipped")), /inspection-skipped$/);
});

test("fabrica status and fabrica log both name the mode for a real self-tested record", async () => {
  const recordHome = tempRecordHome();
  const id = registerTask(recordHome, "a self-tested task").id;
  appendEvent(recordHome, { taskId: id, name: "inspection-skipped", details: { reason: "Inspector is not installed" } });
  appendEvent(recordHome, { taskId: id, name: "work-started", details: { project: "/p" } });
  appendEvent(recordHome, { taskId: id, name: "check-run", details: { attempt: 1, green: true } });
  appendEvent(recordHome, { taskId: id, name: "delivered", details: { outcome: "done" } });

  const statusIo = captureIo();
  assert.equal(await runStatusCommand([], { recordHome, ...statusIo }), 0);
  const row = statusIo.out.find((line) => line.startsWith(`${id}  `));
  assert.ok(row, `no task row for ${id}: ${JSON.stringify(statusIo.out)}`);
  assert.match(row, /self-tested, not independently checked/);

  const logIo = captureIo();
  assert.equal(await runLogCommand([id], { recordHome, ...logIo }), 0);
  assert.ok(
    logIo.out.some((line) => line.includes("check mode: self-tested, not independently checked - Inspector is not installed")),
    `no mode line in the log: ${JSON.stringify(logIo.out)}`
  );
});
