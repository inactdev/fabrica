// Unit coverage for requireCapForBrain (issue #200) - the one other
// thing rule 10 gates on besides room under an already-configured cap:
// whether a brain that must not run without one has one configured at
// all. requireRoomToStart's own behavior is covered end to end by
// contract/rule10.spend-caps.test.ts; this file is just the new function.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireCapForBrain } from "./caps.ts";
import { ForemanError } from "./errors.ts";
import { readEventsForTask } from "../record/index.ts";
import type { Brain } from "../brain/index.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-caps-home-"));
}

function minimalBrain(requiresPerTaskCap: boolean): Brain {
  return {
    name: "fake-direct-api",
    model: "fake-1",
    ...(requiresPerTaskCap ? { requiresPerTaskCap: true } : {}),
    async ask() {
      return {};
    },
    async work() {
      return { transcript: [] };
    },
  };
}

test("requireCapForBrain is a no-op for a brain that does not require a cap, cap configured or not", () => {
  const recordHome = freshHome();
  const brain = minimalBrain(false);
  assert.doesNotThrow(() => requireCapForBrain(recordHome, "t1", brain, undefined));
  assert.doesNotThrow(() => requireCapForBrain(recordHome, "t1", brain, { perTaskUsd: 1 }));
  assert.deepEqual(readEventsForTask(recordHome, "t1"), []);
});

test("requireCapForBrain refuses a cap-requiring brain when caps is entirely unset", () => {
  const recordHome = freshHome();
  const brain = minimalBrain(true);

  assert.throws(
    () => requireCapForBrain(recordHome, "t1", brain, undefined),
    (err: unknown) =>
      err instanceof ForemanError && err.code === "cap-refused" && /perTaskUsd/.test(err.message) && /fake-direct-api/.test(err.message)
  );

  const events = readEventsForTask(recordHome, "t1");
  assert.equal(events.length, 1);
  assert.equal(events[0].name, "cap-refused");
  assert.equal((events[0].details as { reason?: string }).reason, "adapter-requires-cap");
});

test("requireCapForBrain refuses when only perDayUsd is set - this is about perTaskUsd specifically", () => {
  const recordHome = freshHome();
  const brain = minimalBrain(true);

  assert.throws(
    () => requireCapForBrain(recordHome, "t1", brain, { perDayUsd: 100 }),
    (err: unknown) => err instanceof ForemanError && err.code === "cap-refused"
  );
});

test("requireCapForBrain does not throw once perTaskUsd is configured, however small", () => {
  const recordHome = freshHome();
  const brain = minimalBrain(true);
  assert.doesNotThrow(() => requireCapForBrain(recordHome, "t1", brain, { perTaskUsd: 0 }));
  assert.deepEqual(readEventsForTask(recordHome, "t1"), []);
});

test("requireCapForBrain's refusal names the project when given one", () => {
  const recordHome = freshHome();
  const brain = minimalBrain(true);

  assert.throws(() => requireCapForBrain(recordHome, "t1", brain, undefined, { project: "my-project" }));

  const [event] = readEventsForTask(recordHome, "t1");
  assert.equal((event.details as { project?: string }).project, "my-project");
});
