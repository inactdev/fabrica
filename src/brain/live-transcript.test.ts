import { test } from "node:test";
import assert from "node:assert/strict";
import { emitLiveTranscriptEntry, registerLiveTranscriptListener } from "./live-transcript.ts";
import type { TranscriptEntry } from "./types.ts";

function entry(text: string): TranscriptEntry {
  return { occurredAt: "2026-01-01T00:00:00.000Z", kind: "text", text };
}

test("emitLiveTranscriptEntry reaches the listener registered for that exact workdir", () => {
  const seen: string[] = [];
  const unregister = registerLiveTranscriptListener("/tmp/a", (e) => seen.push(e.text));
  emitLiveTranscriptEntry("/tmp/a", entry("one"));
  unregister();
  assert.deepEqual(seen, ["one"]);
});

test("emitLiveTranscriptEntry for an unregistered workdir is a silent no-op", () => {
  // Nothing to assert beyond "this doesn't throw" - a brain that emits
  // live and has no listener (no caller opted in) must never crash.
  emitLiveTranscriptEntry("/tmp/nobody-is-listening", entry("ignored"));
});

test("two different workdirs never cross wires", () => {
  const seenA: string[] = [];
  const seenB: string[] = [];
  const unregisterA = registerLiveTranscriptListener("/tmp/a", (e) => seenA.push(e.text));
  const unregisterB = registerLiveTranscriptListener("/tmp/b", (e) => seenB.push(e.text));
  emitLiveTranscriptEntry("/tmp/a", entry("for-a"));
  emitLiveTranscriptEntry("/tmp/b", entry("for-b"));
  unregisterA();
  unregisterB();
  assert.deepEqual(seenA, ["for-a"]);
  assert.deepEqual(seenB, ["for-b"]);
});

test("unregister only removes the listener it was handed back for, not a later one for the same workdir", () => {
  const seen: string[] = [];
  const unregisterFirst = registerLiveTranscriptListener("/tmp/a", () => {
    throw new Error("the stale listener must never fire");
  });
  const unregisterSecond = registerLiveTranscriptListener("/tmp/a", (e) => seen.push(e.text));
  // A stale unregister (as if the first call's `finally` ran late)
  // must not evict the second, still-live listener.
  unregisterFirst();
  emitLiveTranscriptEntry("/tmp/a", entry("second"));
  unregisterSecond();
  assert.deepEqual(seen, ["second"]);
});
