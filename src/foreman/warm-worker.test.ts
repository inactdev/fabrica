import { test } from "node:test";
import assert from "node:assert/strict";

import { ForemanError } from "./errors.ts";
import { sessionGoneReason, withColdStartFallback } from "./warm-worker.ts";
import type { WarmWorkerRestartedDetails } from "./warm-worker.ts";

test("the wording the reference adapter really produces for a dead session is recognized", () => {
  // Verified against the real binary and written down in the reference
  // CLI adapter's own document under src/brain/adapters/ ("Warm
  // sessions"): exit code 1, this one line on stderr, which the adapter
  // passes through verbatim. (Named that way rather than by file because
  // CONTRACT rule 8's scan flags the vendor's name anywhere under src/
  // outside that directory - an import specifier and a comment alike.)
  const reason = sessionGoneReason(new Error("No conversation found with session ID: abc-123"));
  assert.notEqual(reason, undefined);
  assert.match(reason!, /session/i);
});

test("the other ordinary ways a tool says the session is gone are recognized", () => {
  for (const message of [
    "session not found",
    "Conversation abc does not exist",
    "unknown session: abc-123",
    "this session has expired",
    "could not resume the conversation",
    "that chat is no longer available",
  ]) {
    assert.notEqual(sessionGoneReason(new Error(message)), undefined, message);
  }
});

test("a refusal wrapped one or two levels down is still recognized", () => {
  const inner = new Error("No conversation found with session ID: abc-123");
  const outer = new Error("the worker failed", { cause: new Error("wrapped", { cause: inner }) });
  assert.notEqual(sessionGoneReason(outer), undefined);
});

test("anything the allowlist does not recognize is not a dead session", () => {
  for (const message of [
    "Invalid API key · Fix external API key",
    "connection closed mid-response",
    "There's an issue with the selected model",
    // A refusal that merely mentions the flag is not evidence about the
    // session itself.
    "--resume is not supported in this mode",
    "exit code 1",
  ]) {
    assert.equal(sessionGoneReason(new Error(message)), undefined, message);
  }
});

test("Fabrica's own refusals are never read as a dead session", () => {
  // A ForemanError is Fabrica's own statement about its own state. Even
  // one whose message happened to be worded this way must not cause a
  // whole worker call to be re-run cold.
  const err = new ForemanError("worker-network-gone", "no session found for this worker");
  assert.equal(sessionGoneReason(err), undefined);
});

test("a warm call that works is the only call made, and nothing is recorded", async () => {
  const sessions: (string | undefined)[] = [];
  const restarts: WarmWorkerRestartedDetails[] = [];

  const result = await withColdStartFallback(
    (session) => {
      sessions.push(session);
      return Promise.resolve("done");
    },
    { session: "warm-1", onRestart: (details) => restarts.push(details) }
  );

  assert.equal(result, "done");
  assert.deepEqual(sessions, ["warm-1"]);
  assert.deepEqual(restarts, []);
});

test("a dead session is restarted cold, once, with no session at all", async () => {
  const sessions: (string | undefined)[] = [];
  const restarts: WarmWorkerRestartedDetails[] = [];

  const result = await withColdStartFallback(
    (session) => {
      sessions.push(session);
      if (session !== undefined) {
        return Promise.reject(new Error("No conversation found with session ID: warm-1"));
      }
      return Promise.resolve("done cold");
    },
    { session: "warm-1", onRestart: (details) => restarts.push(details) }
  );

  assert.equal(result, "done cold");
  assert.deepEqual(sessions, ["warm-1", undefined], "the cold call must not be handed the refused session");
  assert.equal(restarts.length, 1);
  assert.equal(restarts[0].session, "warm-1");
  assert.match(restarts[0].error, /No conversation found/);
  assert.match(restarts[0].reason, /session/i);
});

test("the record says a restart is happening before the cold call is made", async () => {
  const order: string[] = [];

  await withColdStartFallback(
    (session) => {
      order.push(session === undefined ? "cold call" : "warm call");
      if (session !== undefined) return Promise.reject(new Error("session not found"));
      return Promise.resolve(null);
    },
    { session: "warm-1", onRestart: () => order.push("recorded") }
  );

  assert.deepEqual(order, ["warm call", "recorded", "cold call"]);
});

test("a failure that is not a dead session propagates untouched, with no second call", async () => {
  let calls = 0;
  const restarts: WarmWorkerRestartedDetails[] = [];
  const thrown = new Error("Invalid API key · Fix external API key");

  await assert.rejects(
    () =>
      withColdStartFallback(
        () => {
          calls += 1;
          return Promise.reject(thrown);
        },
        { session: "warm-1", onRestart: (details) => restarts.push(details) }
      ),
    (err: unknown) => err === thrown
  );
  assert.equal(calls, 1);
  assert.deepEqual(restarts, []);
});

test("the cold call's own failure is the honest answer - there is no second fallback", async () => {
  let calls = 0;
  const cold = new Error("the worker box died");

  await assert.rejects(
    () =>
      withColdStartFallback(
        (session) => {
          calls += 1;
          if (session !== undefined) return Promise.reject(new Error("session not found"));
          return Promise.reject(cold);
        },
        { session: "warm-1", onRestart: () => {} }
      ),
    (err: unknown) => err === cold
  );
  assert.equal(calls, 2, "warm then cold, and no further tries");
});

test("a round with no warm worker to resume makes exactly one call and never records a restart", async () => {
  const sessions: (string | undefined)[] = [];
  const restarts: WarmWorkerRestartedDetails[] = [];

  await withColdStartFallback(
    (session) => {
      sessions.push(session);
      return Promise.resolve(null);
    },
    { session: undefined, onRestart: (details) => restarts.push(details) }
  );

  assert.deepEqual(sessions, [undefined]);
  assert.deepEqual(restarts, []);
});

test("a first round's failure is never swallowed by the fallback", async () => {
  const thrown = new Error("No conversation found with session ID: whatever");
  await assert.rejects(
    () => withColdStartFallback(() => Promise.reject(thrown), { session: undefined, onRestart: () => {} }),
    (err: unknown) => err === thrown
  );
});
