// Issue #189, end to end: a round the subscription meter stops, and the
// next start the pause rule refuses afterwards. The pieces are unit-
// tested in meters.test.ts and attempts.test.ts; this is the whole loop
// - a real ProductionLine, a real record - proving the Client sees a
// pause rather than a failure, and that nothing restarts by itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doTask } from "./do.ts";
import { DEFAULT_HEARTBEAT_INTERVAL_MS } from "./attempts.ts";
import { ForemanError } from "./errors.ts";
import { deliveryOf, receiptsOf, stateOf } from "./queries.ts";
import { readEventsForTask, readTaskFile } from "../record/index.ts";
import { registerMeterSource } from "../brain/meters.ts";
import type { Brain, BrainWorkResult, MeterReading } from "../brain/index.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { fixtureCheckBox } from "../../contract/helpers/fake-check-box.ts";

function freshHome(pause?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-meter-round-"));
  if (pause !== undefined) writeFileSync(join(dir, "projects.toml"), pause);
  return dir;
}

function reading(sevenDayPercent: number): MeterReading {
  return { observedAt: new Date().toISOString(), fiveHourPercent: 12, sevenDayPercent };
}

/** Everything a worker's `work()` returns when it did reach the end of
 * its own work - with the reading on a "meters" transcript entry, the
 * way the reference adapter reports it. */
function finishedWork(sevenDayPercent: number): BrainWorkResult {
  return {
    transcript: [
      { occurredAt: new Date().toISOString(), kind: "text", text: "worked" },
      { occurredAt: new Date().toISOString(), kind: "meters", text: JSON.stringify(reading(sevenDayPercent)) },
    ],
    session: "s1",
    writeup: {
      title: "Metered fake update",
      why: "Testing.",
      what: "Worked.",
      how: "Directly.",
      outsideChanges: "None.",
      confidence: 90,
      assumptions: "None.",
      expectedOutcomes: "It lands.",
      deviations: "None.",
    },
  };
}

/** A worker that finishes normally and reports the week at
 * `sevenDayPercent` - what puts a reading on the record. */
function brainWithReading(sevenDayPercent: number): Brain {
  return {
    name: "metered-fake",
    model: "metered-1",
    async ask() {
      return { costUsd: 0 };
    },
    async work() {
      return finishedWork(sevenDayPercent);
    },
  };
}

/** A worker whose box reports the week already past its stop threshold
 * and which sits in `work()` until it is asked to stop - the shape of a
 * real attempt that gets a reading back from its own relay mid-call.
 * The wait outlasts one real heartbeat interval, which is when the
 * Foreman looks. */
function brainOverTheWeek(sevenDayPercent: number): Brain & { pauses: number } {
  const state = { pauses: 0 };
  return {
    name: "metered-fake",
    model: "metered-1",
    get pauses() {
      return state.pauses;
    },
    async ask() {
      return { costUsd: 0 };
    },
    async work(_brief, workdir) {
      let paused = false;
      const unregister = registerMeterSource(workdir, {
        reading: () => reading(sevenDayPercent),
        pause: () => {
          state.pauses += 1;
          paused = true;
        },
      });
      try {
        const deadline = Date.now() + DEFAULT_HEARTBEAT_INTERVAL_MS * 2;
        while (!paused && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      } finally {
        unregister();
      }
      // A stopped worker leaves whatever it had done behind, with no
      // write-up: it never reached the end of its own work.
      return { transcript: [{ occurredAt: new Date().toISOString(), kind: "text", text: "partway" }], session: "s1" };
    },
  };
}

test("a round the week's meter stops delivers as paused-by-meter - waiting on the Client, never a failure", async () => {
  const project = makeFixtureRepo("exit 0", { inspector: false });
  const recordHome = freshHome();
  const brain = brainOverTheWeek(94);

  // One attempt: this test waits out a real heartbeat interval, which is
  // when the Foreman actually reads the meters.
  const task = await doTask(recordHome, "a long job", {
    project,
    brain,
    attempts: 1,
    checkBox: fixtureCheckBox().box,
  });

  assert.equal(brain.pauses >= 1, true, "the worker was asked to stop");
  const delivery = deliveryOf(recordHome, task.id);
  assert.equal(delivery?.outcome, "paused-by-meter");
  assert.match(delivery!.summary, /94% of the 7-day window/);
  assert.match(delivery!.evidence, /stop threshold 90%/);
  assert.match(delivery!.gaps, /A limit stopped this task, not its work/);
  assert.match(delivery!.gaps, /fix verdict/);
  assert.equal(delivery!.branch, `fabrica/${task.id}`);

  // Never a failure: the task reads as waiting on the Client's ruling,
  // exactly as the Client's clarification required.
  assert.equal(task.state, "delivered");
  assert.equal(stateOf(readEventsForTask(recordHome, task.id)), "delivered");

  const [receipt] = receiptsOf(recordHome, task.id);
  assert.equal(receipt.outcome, "paused-by-meter");
  assert.equal(receipt.meters?.sevenDayPercent, 94);
  assert.equal(receipt.checks, null, "nothing judged a paused attempt");

  const paused = readEventsForTask(recordHome, task.id).find((e) => e.name === "meter-paused");
  assert.ok(paused, "the pause is on the record as its own event");
  const details = paused!.details as { usedPercent: number; thresholdPercent: number; workerStopped: boolean };
  assert.equal(details.usedPercent, 94);
  assert.equal(details.thresholdPercent, 90);
  assert.equal(details.workerStopped, true);

  assert.match(readTaskFile(recordHome, task.id, "delivery.md") ?? "", /Paused by the subscription meter/);
});

test("the pause rule refuses the next start once a round has left a reading over the threshold", async () => {
  const project = makeFixtureRepo("exit 0", { inspector: false });
  const recordHome = freshHome();

  // One ordinary round, which leaves its own reading on its receipt -
  // the only thing a brand-new task afterwards has to go on.
  await doTask(recordHome, "a first job", { project, brain: brainWithReading(88), checkBox: fixtureCheckBox().box });

  await assert.rejects(
    () => doTask(recordHome, "another job", { project, brain: brainWithReading(88), checkBox: fixtureCheckBox().box }),
    (err: unknown) => {
      assert.ok(err instanceof ForemanError);
      assert.equal(err.code, "meter-refused");
      assert.match(err.message, /88% of the 7-day window/);
      assert.match(err.message, /new work stops above 70%/);
      return true;
    }
  );
});

test("a round below both thresholds is untouched, and still records the meters on its receipt", async () => {
  const project = makeFixtureRepo("exit 0", { inspector: false });
  const recordHome = freshHome();

  const task = await doTask(recordHome, "an ordinary job", {
    project,
    brain: brainWithReading(20),
    checkBox: fixtureCheckBox().box,
  });

  assert.equal(readEventsForTask(recordHome, task.id).some((e) => e.name === "meter-paused"), false);
  assert.equal(deliveryOf(recordHome, task.id)?.outcome, "done");
  const [receipt] = receiptsOf(recordHome, task.id);
  assert.equal(receipt.meters?.sevenDayPercent, 20);
  assert.equal(receipt.meters?.fiveHourPercent, 12);
});

test("a raised [pause] threshold in projects.toml lets the same week through", async () => {
  const project = makeFixtureRepo("exit 0", { inspector: false });
  const recordHome = freshHome("[pause]\nsevenDayRefusePercent = 95\nsevenDayStopPercent = 99\n");

  await doTask(recordHome, "a first job", { project, brain: brainWithReading(94), checkBox: fixtureCheckBox().box });
  // 94% is under both raised thresholds, so a second task starts
  // normally where the defaults would have refused it outright.
  const second = await doTask(recordHome, "a second job", {
    project,
    brain: brainWithReading(94),
    checkBox: fixtureCheckBox().box,
  });
  assert.equal(deliveryOf(recordHome, second.id)?.outcome, "done");
});
