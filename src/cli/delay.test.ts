import { test } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { delay } from "./delay.ts";

test("delay: resolves after the wait and leaves nothing on the signal", async () => {
  const controller = new AbortController();
  const startedAt = Date.now();

  await delay(20, controller.signal);

  assert.ok(Date.now() - startedAt >= 15);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("delay: many waits on one signal do not accumulate listeners", async () => {
  const controller = new AbortController();

  for (let i = 0; i < 50; i++) await delay(0, controller.signal);

  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("delay: aborting returns at once and leaves nothing on the signal", async () => {
  const controller = new AbortController();
  const startedAt = Date.now();

  const waited = delay(10_000, controller.signal);
  controller.abort();
  await waited;

  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("delay: an already-aborted signal returns without waiting", async () => {
  const controller = new AbortController();
  controller.abort();
  const startedAt = Date.now();

  await delay(10_000, controller.signal);

  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
