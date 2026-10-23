// Issue #167, end to end: a round whose worker crashed mid-attempt.
//
// The incident behind it - the model connection dropped mid-response
// after 18 minutes of worker time - left no receipt at all, so the
// task's cost stayed at its previous value and the daily cap never saw
// that spend. Rule 10 says unknown spend is never counted as zero. The
// receipt itself is unit-tested in attempts.test.ts; this is the whole
// loop, with a real ProductionLine and a real record, proving the
// unmeasured receipt lands, that it blocks every new start while a cap
// is set, that `fabrica cost` clears the block, and that a failure
// before the worker was ever called records no spend at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doTask } from "./do.ts";
import { recordCost } from "./caps.ts";
import { ForemanError } from "./errors.ts";
import { deliveryOf, receiptsOf, stateOf } from "./queries.ts";
import { readEvents, readEventsForTask } from "../record/index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo, pushToOrigin } from "../../contract/helpers/fixture.ts";
import { fixtureCheckBox } from "../../contract/helpers/fake-check-box.ts";
import type { Brain } from "../brain/index.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-crashed-spend-"));
}

/** The id of the FIRST task a record home ever saw. These tests never
 * get a return value to read it from - the `doTask` call they are about
 * throws - and each one uses its own fresh home, so the first task in it
 * is the crashed one. */
function firstTaskId(recordHome: string): string {
  return readEvents(recordHome)[0].taskId;
}

/** A worker whose `work()` call dies partway through - the connection
 * dropping mid-response, its box going away - after a clarifying step
 * that cost a known nothing, so the only unmeasured spend any of this
 * leaves on the record is the crashed attempt's own. */
function crashingBrain(message: string): Brain {
  return {
    name: "crashing",
    model: "crashing-1",
    async ask() {
      return { costUsd: 0 };
    },
    async work() {
      throw new Error(message);
    },
  };
}

test("a crashed attempt leaves an unmeasured receipt on the record, not a silent gap", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0", { inspector: false });

  await assert.rejects(
    () =>
      doTask(recordHome, "a long job", {
        project,
        brain: crashingBrain("API Error: Connection closed mid-response"),
        checkBox: fixtureCheckBox().box,
      }),
    /Connection closed mid-response/
  );

  const taskId = firstTaskId(recordHome);
  const events = readEventsForTask(recordHome, taskId);
  assert.equal(
    events.filter((event) => event.name === "receipt-recorded").length,
    1,
    "the crashed attempt's spend must reach the record exactly once"
  );

  const [receipt] = receiptsOf(recordHome, taskId);
  assert.equal(receipt.costUnknown, true);
  assert.equal(receipt.costUsd, null, "never $0 for spend nobody measured");
  assert.equal(receipt.outcome, "failed");
  assert.equal(receipt.checks, null, "nothing judged an attempt that never finished");
  assert.equal(receipt.attempt, 1);
  assert.equal(receipt.brain, "crashing");

  // The receipt is spend, not progress: the task still reads as failed,
  // and there is no delivery to rule on.
  assert.equal(stateOf(events), "failed");
  assert.equal(deliveryOf(recordHome, taskId), null);
  assert.ok(
    events.some((event) => event.name === "task-failed"),
    "the crash itself is still reported as the task's own failure"
  );
});

test("a crashed attempt's unknown cost halts every new start under a cap, and `fabrica cost` clears it", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0", { inspector: false });
  const caps = { perDayUsd: 100 };

  await assert.rejects(
    () =>
      doTask(recordHome, "a long job", {
        project,
        brain: crashingBrain("the container died"),
        checkBox: fixtureCheckBox().box,
        caps,
      }),
    /the container died/
  );
  const crashed = firstTaskId(recordHome);

  // Nothing new may start - not because a cap was reached (the day's
  // known spend is $0 against $100), but because one attempt's cost is
  // unknown, and unknown is never counted as zero.
  await assert.rejects(
    () =>
      doTask(recordHome, "another job", {
        project,
        brain: fakeBrain({ costUsd: 0.02 }),
        checkBox: fixtureCheckBox().box,
        caps,
      }),
    (err: unknown) => {
      assert.ok(err instanceof ForemanError, `expected a ForemanError, got ${String(err)}`);
      assert.equal(err.code, "spend-unknown");
      assert.match(err.message, /SPEND UNKNOWN - tasks blocked/);
      assert.ok(err.message.includes(`task ${crashed}, attempt 1`), err.message);
      assert.ok(err.message.includes(`fabrica cost ${crashed} <usd>`), err.message);
      return true;
    }
  );

  // The owner's own figure for what the crashed attempt really cost -
  // the only thing that clears the block (clarification: reconciliation
  // needs no new path, `fabrica cost` already covers it).
  recordCost(recordHome, crashed, 1.75);

  const next = await doTask(recordHome, "a third job", {
    project,
    brain: fakeBrain({ costUsd: 0.02 }),
    checkBox: fixtureCheckBox().box,
    caps,
  });
  assert.equal(deliveryOf(recordHome, next.id)?.outcome, "done", "recording the real cost is what lets work start again");
});

test("a failure before the worker was ever called records no spend at all", async () => {
  // The other half of the ruling: from outside a crashed `work()` call
  // nobody can tell whether money moved, but a round that died in
  // Fabrica's own code before the worker ran spent nothing, and an
  // unmeasured receipt there would block every new task over spend that
  // never happened. Here the project has no check command, which
  // `prepareRound` refuses after the line is cut and before the first
  // attempt.
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0", { inspector: false });
  rmSync(join(project, "check.sh"));
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "no check"], { cwd: project });
  pushToOrigin(project);
  const brain = fakeBrain();

  await assert.rejects(
    () => doTask(recordHome, "a job that never starts", { project, brain, checkBox: fixtureCheckBox().box }),
    /check\.sh/
  );

  const events = readEventsForTask(recordHome, firstTaskId(recordHome));
  assert.equal(brain.calls, 0, "the worker never ran");
  assert.equal(
    events.filter((event) => event.name === "receipt-recorded").length,
    0,
    "nothing unmeasured may be left behind for a cap to block on"
  );
  assert.equal(stateOf(events), "failed");
});
