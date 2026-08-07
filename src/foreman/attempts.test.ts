import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAttempts, gateForRecord, MAX_RECEIPT_CHECK_OUTPUT_BYTES } from "./attempts.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import type { Brain } from "../brain/index.ts";

const HEAD_MARKER = "FIRST-LINE-OF-CHECK-OUTPUT";
const TAIL_MARKER = "LAST-LINE-OF-CHECK-OUTPUT";

/** A workdir whose check prints far more than a receipt may store, and
 * fails - the shape of a verbose test suite going red. */
function workdirWithNoisyRedCheck(): string {
  const workdir = mkdtempSync(join(tmpdir(), "fabrica-attempts-"));
  const script = join(workdir, "check.sh");
  const filler = `${"x".repeat(79)}\n`.repeat(4000);
  writeFileSync(script, `#!/bin/sh\necho "${HEAD_MARKER}"\ncat <<'EOF'\n${filler}EOF\necho "${TAIL_MARKER}"\nexit 1\n`);
  chmodSync(script, 0o755);
  return workdir;
}

test("a receipt stores only the tail of a long check output, behind a truncation marker", async () => {
  const workdir = workdirWithNoisyRedCheck();

  const { receipts } = await runAttempts({
    brain: fakeBrain(),
    brief: "do the thing",
    workdir,
    taskId: "task-1",
    check: "./check.sh",
    totalAttempts: 1,
    stopEarlyOnGreen: false,
  });

  const stored = receipts[0].checks!.output;
  assert.match(stored, /^\[truncated, showing last \d+ of \d+ bytes\]\n/);
  assert.ok(
    Buffer.byteLength(stored, "utf8") < MAX_RECEIPT_CHECK_OUTPUT_BYTES + 200,
    `stored output was ${Buffer.byteLength(stored, "utf8")} bytes`
  );
  assert.ok(stored.includes(TAIL_MARKER), "the end of the output - where a check says what failed - is kept");
  assert.ok(!stored.includes(HEAD_MARKER), "the beginning is what gets dropped");
  assert.equal(receipts[0].checks!.green, false);
});

test("the next attempt's correction brief still gets the untruncated check output", async () => {
  const workdir = workdirWithNoisyRedCheck();
  const briefs: string[] = [];

  const { receipts } = await runAttempts({
    brain: fakeBrain({ onWork: (brief) => briefs.push(brief) }),
    brief: "do the thing",
    workdir,
    taskId: "task-1",
    check: "./check.sh",
    totalAttempts: 2,
    stopEarlyOnGreen: false,
  });

  assert.equal(briefs.length, 2);
  assert.ok(briefs[1].includes(HEAD_MARKER), "the worker sees the whole failure, from its first line");
  assert.ok(briefs[1].includes(TAIL_MARKER));
  assert.ok(!briefs[1].includes("[truncated,"));
  assert.ok(Buffer.byteLength(briefs[1], "utf8") > MAX_RECEIPT_CHECK_OUTPUT_BYTES);
  assert.ok(!receipts[0].checks!.output.includes(HEAD_MARKER));
});

test("a check output within the cap is stored exactly as it ran, with no marker", () => {
  const gate = { green: true, output: "./check.sh -> exit 0\nall good\n" };
  assert.equal(gateForRecord(gate), gate);
});

// Three bytes per character, against a cap that is not a multiple of
// three: the cut lands mid-character, which is exactly the case that
// would otherwise store a replacement symbol as the first thing read.
test("truncation never stores a half-character left by cutting mid-symbol", () => {
  const wide = "あ";
  const output = wide.repeat(20000);

  const stored = gateForRecord({ green: false, output }).output;

  assert.ok(!stored.includes("\uFFFD"));
  assert.ok(stored.endsWith(wide));
  assert.match(stored, /^\[truncated, showing last \d+ of 60000 bytes\]\nあ/);
});

// Heartbeat coverage for the attempt loop (issue #12): a `brain.work` call
// is one long opaque await with nothing incremental to report, so
// `onHeartbeat` is the only signal `fabrica status`/`watch` get that a
// silent stretch is still progress and not a stuck worker.

function slowBrain(delayMs: number): Brain {
  return {
    name: "slow",
    model: "slow-1",
    async work() {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { transcript: [], session: "s1" };
    },
    async ask() {
      return {};
    },
  };
}

function fastCheckWorkdir(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-attempts-"));
}

test("runAttempts: onHeartbeat fires repeatedly while brain.work is in flight", async () => {
  const beats: number[] = [];

  await runAttempts({
    brain: slowBrain(55),
    brief: "do it",
    workdir: fastCheckWorkdir(),
    taskId: "t1",
    check: "exit 0",
    totalAttempts: 1,
    stopEarlyOnGreen: true,
    heartbeatIntervalMs: 10,
    onHeartbeat: (attempt) => beats.push(attempt),
  });

  assert.ok(beats.length >= 3, `expected several heartbeats, got ${beats.length}`);
  assert.ok(
    beats.every((a) => a === 1),
    `every heartbeat should report attempt 1, got ${JSON.stringify(beats)}`
  );
});

test("runAttempts: heartbeat stops the instant brain.work resolves", async () => {
  let beats = 0;

  await runAttempts({
    brain: slowBrain(20),
    brief: "do it",
    workdir: fastCheckWorkdir(),
    taskId: "t1",
    check: "exit 0",
    totalAttempts: 1,
    stopEarlyOnGreen: true,
    heartbeatIntervalMs: 5,
    onHeartbeat: () => beats++,
  });

  const afterCompletion = beats;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(beats, afterCompletion, "no heartbeat should fire once the call has already resolved");
});

test("runAttempts: no onHeartbeat given, no timer runs (no crash, no leak)", async () => {
  const result = await runAttempts({
    brain: slowBrain(5),
    brief: "do it",
    workdir: fastCheckWorkdir(),
    taskId: "t1",
    check: "exit 0",
    totalAttempts: 1,
    stopEarlyOnGreen: true,
  });

  assert.equal(result.receipts.length, 1);
});
