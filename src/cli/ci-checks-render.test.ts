// Issue #267's third ask: status, watch and the live view show the
// checks' state on the task line instead of a bare "delivered". These
// cover the CLI half - `render.ts`'s reader and the three places that
// phrase appears (the status line, `fabrica watch`'s terminal notice,
// and `fabrica log`'s own rendering of the two new events).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checksSummaryFromEvents,
  formatEventLine,
  formatStatusLine,
  formatTerminalNotice,
} from "./render.ts";
import type { FabricaEvent } from "../index.ts";

function event(name: FabricaEvent["name"], details?: unknown, occurredAt = "2026-10-22T10:00:00.000Z"): FabricaEvent {
  return { occurredAt, taskId: "20261022-t-aa", name, ...(details === undefined ? {} : { details }) };
}

const FINISHED_RED = event("ci-checks-finished", {
  prUrl: "https://github.com/o/r/pull/7",
  sha: "abc",
  verdict: "red",
  summary: "5 green, rehearsal red",
  green: 5,
  red: ["rehearsal"],
  unknown: [],
});

test("checksSummaryFromEvents reads the latest read's own phrase, verbatim", () => {
  const events = [
    event("work-started", { project: "/p" }),
    FINISHED_RED,
    event("ci-checks-finished", { verdict: "green", summary: "6 green", green: 6, red: [], unknown: [], prUrl: "", sha: "" }),
  ];
  assert.equal(checksSummaryFromEvents(events), "6 green");
});

test("checksSummaryFromEvents is null until a read has finished", () => {
  assert.equal(checksSummaryFromEvents([event("work-started", { project: "/p" })]), null);
  assert.equal(checksSummaryFromEvents([]), null);
  // A read that recorded an empty phrase says nothing rather than
  // printing an empty label.
  assert.equal(checksSummaryFromEvents([event("ci-checks-finished", { summary: "   " })]), null);
});

test("a delivered task's status line carries the checks' state, not a bare 'delivered'", () => {
  const line = formatStatusLine(
    { id: "20261022-t-aa", state: "delivered" },
    {
      project: "/p",
      ageMs: 60_000,
      liveness: null,
      hasDelivery: true,
      checksSummary: "5 green, rehearsal red",
    }
  );
  assert.match(line, /CI: 5 green, rehearsal red/);
  assert.match(line, /AWAITING YOUR VERDICT/);
});

test("a status line with no read behind it says nothing about CI at all", () => {
  const line = formatStatusLine(
    { id: "20261022-t-aa", state: "working" },
    { project: "/p", ageMs: 1_000, liveness: null, hasDelivery: false }
  );
  assert.doesNotMatch(line, /CI:/);
});

test("fabrica watch's own delivered notice names the checks' state", () => {
  const notice = formatTerminalNotice("delivered", {
    taskId: "20261022-t-aa",
    hasDelivery: true,
    checksSummary: "5 green, rehearsal red",
  });
  assert.match(notice ?? "", /task delivered \[CI: 5 green, rehearsal red\]/);
});

test("fabrica watch's notice is unchanged when nothing was read", () => {
  assert.equal(
    formatTerminalNotice("delivered", { taskId: "20261022-t-aa", hasDelivery: true }),
    "-- task delivered - nothing more expected on this transcript unless a `fix` verdict wakes the worker again --"
  );
});

test("fabrica log renders a concluded check as prose, never the raw object", () => {
  const line = formatEventLine(
    event("ci-check-concluded", {
      name: "nixfmt",
      source: "check-run",
      conclusion: "failure",
      red: true,
      url: "https://github.com/o/r/runs/9",
      logTail: "Error: not formatted",
    })
  );
  assert.match(line, /CI check "nixfmt": red \(failure\), job log captured - https:\/\/github\.com\/o\/r\/runs\/9/);
  // The log tail is deliberately not on the line: it is the unbounded,
  // many-line text this rendering exists to keep out of a log.
  assert.doesNotMatch(line, /not formatted/);
});

test("fabrica log renders the summary event with the same phrase the task line shows", () => {
  const line = formatEventLine(FINISHED_RED);
  assert.match(line, /CI checks finished: 5 green, rehearsal red \(https:\/\/github\.com\/o\/r\/pull\/7\)/);
});
