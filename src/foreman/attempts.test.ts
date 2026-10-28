import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAttempts, gateForRecord, withHeartbeat, MAX_RECEIPT_CHECK_OUTPUT_BYTES } from "./attempts.ts";
import { ForemanError } from "./errors.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { emitLiveTranscriptEntry } from "../brain/live-transcript.ts";
import { registerRelayHealthProbe } from "../brain/relay-health.ts";
import { registerMeterSource } from "../brain/meters.ts";
import { METER_READING_MAX_AGE_MS } from "./meters.ts";
import { DEFAULT_PAUSE_RULE } from "../config/index.ts";
import type { Brain } from "../brain/index.ts";
import type { Receipt } from "../inspector/types.ts";
import type { Judge } from "./judge.ts";

const HEAD_MARKER = "FIRST-LINE-OF-CHECK-OUTPUT";
const TAIL_MARKER = "LAST-LINE-OF-CHECK-OUTPUT";

/** A judge whose red verdict carries far more output than a receipt may
 * store - the shape of a verbose test suite going red. */
const noisyRedJudge: Judge = async () => ({
  kind: "verdict",
  gate: { green: false, output: `${HEAD_MARKER}\n${`${"x".repeat(79)}\n`.repeat(4000)}${TAIL_MARKER}\n` },
});

const greenJudge: Judge = async () => ({ kind: "verdict", gate: { green: true, output: "ok" } });

/** A git repository: every attempt is committed once work() returns. */
function scratchWorkdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-attempts-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

test("a receipt stores only the tail of a long check output, behind a truncation marker", async () => {
  const { receipts } = await runAttempts({
    brain: fakeBrain(),
    brief: "do the thing",
    workdir: scratchWorkdir(),
    taskId: "task-1",
    judge: noisyRedJudge,
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
  const briefs: string[] = [];

  const { receipts } = await runAttempts({
    brain: fakeBrain({ onWork: (brief) => briefs.push(brief) }),
    brief: "do the thing",
    workdir: scratchWorkdir(),
    taskId: "task-1",
    judge: noisyRedJudge,
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

// A valid write-up - these heartbeat tests aren't about the write-up at
// all, but runAttempts makes an attempt red whenever one is missing, so
// without it "lastGate?.green" would be false here for a reason
// unrelated to what this test is actually checking.
const SLOW_WRITEUP = {
  title: "Slow brain update",
  why: "Testing heartbeats.",
  what: "Slept.",
  how: "A timer.",
  outsideChanges: "None.",
  confidence: 90,
  assumptions: "None.",
  expectedOutcomes: "None.",
  deviations: "None.",
  quiz: [
    { question: "What changed?", answer: "The thing this test is about." },
    { question: "Why?", answer: "So the write-up is valid." },
    { question: "What should the owner watch?", answer: "Nothing - this is a test." },
  ],
};

function slowBrain(delayMs: number): Brain {
  return {
    name: "slow",
    model: "slow-1",
    async work() {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        transcript: [],
        session: "s1",
        writeup: SLOW_WRITEUP,
      };
    },
    async ask() {
      return {};
    },
  };
}

/** Waits for something the test is expecting to happen, however long a
 * loaded machine takes to get there. The ceiling is only so a real
 * regression fails the test instead of hanging it - it is never the
 * thing being measured. Same shape as the helper in
 * wait-for-ask-outcome.test.ts. */
async function waitFor(condition: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return condition();
}

/** A worker that comes back only once the test lets it, never on a timer
 * of its own.
 *
 * Issue #133: a fixed sleep plus a short heartbeat interval measures how
 * many ticks the machine managed to fit into the sleep, which is a
 * reading of the machine's load and not of the heartbeat - two beats out
 * of an expected eight went to one beat on a loaded two-core box, and
 * the test failed for a reason that had nothing to do with the code it
 * covers. A test about how many beats arrive holds the worker's call
 * open until those beats really have arrived, then releases it. */
function heldBrain(): { brain: Brain; release: () => void } {
  let released = false;

  return {
    release: () => {
      released = true;
    },
    brain: {
      name: "held",
      model: "held-1",
      async work() {
        await waitFor(() => released);
        return {
          transcript: [],
          session: "s1",
          writeup: SLOW_WRITEUP,
        };
      },
      async ask() {
        return {};
      },
    },
  };
}

/** A worker whose `work()` never settles - no timer, so it holds nothing
 * open once the test that abandoned it is over. Stands in for a box
 * running against a network that is no longer there. */
function stuckBrain(): Brain {
  return {
    name: "stuck",
    model: "none",
    async work() {
      return new Promise<never>(() => {});
    },
    async ask() {
      return {};
    },
  };
}

test("runAttempts: onHeartbeat fires repeatedly while brain.work is in flight", async () => {
  const beats: number[] = [];
  const { brain, release } = heldBrain();

  await runAttempts({
    brain,
    brief: "do it",
    workdir: scratchWorkdir(),
    taskId: "t1",
    judge: greenJudge,
    totalAttempts: 1,
    stopEarlyOnGreen: true,
    heartbeatIntervalMs: 10,
    // "Repeatedly" is the whole claim, so the call is held open until
    // the third beat has really landed rather than for a fixed stretch
    // of wall-clock time a loaded machine may fit fewer ticks into.
    onHeartbeat: (attempt) => {
      beats.push(attempt);
      if (beats.length >= 3) release();
    },
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
    workdir: scratchWorkdir(),
    taskId: "t1",
    judge: greenJudge,
    totalAttempts: 1,
    stopEarlyOnGreen: true,
    heartbeatIntervalMs: 5,
    onHeartbeat: () => beats++,
  });

  const afterCompletion = beats;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(beats, afterCompletion, "no heartbeat should fire once the call has already resolved");
});

test("runAttempts: a throwing onHeartbeat loses the beat, never the task", async () => {
  // The tick runs from a timer, not the awaited path, so an unguarded
  // throw here is an uncaught exception that kills the whole detached
  // worker process mid-task - no delivery event, orphaned worktree.
  // appendEvent throws for real on a short write, ENOSPC, or EACCES.
  let beats = 0;
  const { brain, release } = heldBrain();

  const result = await runAttempts({
    brain,
    brief: "do it",
    workdir: scratchWorkdir(),
    taskId: "t1",
    judge: greenJudge,
    totalAttempts: 1,
    stopEarlyOnGreen: true,
    heartbeatIntervalMs: 5,
    onHeartbeat: () => {
      beats++;
      // The second beat is the entire point: the first one threw, and
      // the tick has to have survived it. Releasing the worker here,
      // rather than after a fixed sleep, is what keeps the count below
      // out of the machine's hands (issue #133). Released before the
      // throw, since this line never returns.
      if (beats >= 2) release();
      throw new Error("record write failed: ENOSPC");
    },
  });

  assert.ok(beats >= 2, `the tick should keep firing after a throw, got ${beats}`);
  assert.equal(result.receipts.length, 1);
  assert.equal(result.lastGate?.green, true);
});

test("runAttempts: no onHeartbeat given, no timer runs (no crash, no leak)", async () => {
  const result = await runAttempts({
    brain: slowBrain(5),
    brief: "do it",
    workdir: scratchWorkdir(),
    taskId: "t1",
    judge: greenJudge,
    totalAttempts: 1,
    stopEarlyOnGreen: true,
  });

  assert.equal(result.receipts.length, 1);
});

// The 2026-10-18 incident's second half: the relay a worker box reaches
// the network through died mid-attempt, and nothing noticed. Heartbeats
// went on being recorded for four minutes, until the box itself reported
// "Unable to connect to API (ConnectionRefused)" - a message that names
// no relay and tells the Client nothing about what actually broke. The
// heartbeat now asks, every tick, whether that relay is still there.
test("runAttempts: a relay that is gone fails the attempt at once, naming the relay", async () => {
  const workdir = scratchWorkdir();
  const beats: number[] = [];
  // Stands in for the relay watcher's verdict (src/relay/container/
  // launch.ts): healthy, then gone.
  let gone = false;
  const unregister = registerRelayHealthProbe(workdir, () =>
    gone ? 'the task\'s network relay (container "fabrica-relay-abc") is no longer running' : undefined
  );
  setTimeout(() => (gone = true), 30);

  try {
    await assert.rejects(
      runAttempts({
        // A worker that never comes back on its own - the real one took
        // four minutes, and the point is that nothing waits for it.
        brain: stuckBrain(),
        brief: "do it",
        workdir,
        taskId: "t1",
        judge: greenJudge,
        totalAttempts: 1,
        stopEarlyOnGreen: true,
        heartbeatIntervalMs: 5,
        onHeartbeat: (attempt) => beats.push(attempt),
        relayGoneGraceMs: 20,
      }),
      (err: unknown) => {
        assert.ok(err instanceof ForemanError, `expected a ForemanError, got ${String(err)}`);
        assert.equal(err.code, "worker-network-gone");
        assert.match(err.message, /relay/);
        assert.match(err.message, /fabrica-relay-abc/);
        return true;
      }
    );

    const beatsWhenItFailed = beats.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(
      beats.length,
      beatsWhenItFailed,
      "a worker known to have lost its network must stop reporting that it is still going"
    );
  } finally {
    unregister();
  }
});

test("runAttempts: a probe that reports nothing leaves the attempt alone", async () => {
  const workdir = scratchWorkdir();
  let asked = 0;
  const unregister = registerRelayHealthProbe(workdir, () => {
    asked += 1;
    return undefined;
  });

  try {
    const result = await runAttempts({
      brain: slowBrain(40),
      brief: "do it",
      workdir,
      taskId: "t1",
      judge: greenJudge,
      totalAttempts: 1,
      stopEarlyOnGreen: true,
      heartbeatIntervalMs: 5,
    });

    assert.ok(asked >= 2, `the probe should be asked on every tick, got ${asked}`);
    assert.equal(result.receipts.length, 1);
    assert.equal(result.lastGate?.green, true);
  } finally {
    unregister();
  }
});

test("withHeartbeat: a probe that throws is not evidence of anything", async () => {
  let beats = 0;
  const result = await withHeartbeat(
    () => beats++,
    5,
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return "finished";
    },
    {
      probe: () => {
        throw new Error("docker is busy");
      },
    }
  );

  assert.equal(result, "finished", "a probe that cannot answer must never fail the call");
  assert.ok(beats >= 2, "and the heartbeat must carry on");
});

// Issue #70: src/brain/live-transcript.ts is the one piece the reference
// adapter's own docker-backed tests can't exercise without Docker - this
// proves runAttempts' own half of the live-delivery contract directly: a
// brain that calls emitLiveTranscriptEntry itself (standing in for an
// adapter mapping its stream as it arrives) gets those entries forwarded
// immediately, and anything its final transcript carries that was never
// emitted that way (a brain's own synthetic trailing entries, or a brain
// with no live signal at all) still reaches onTranscriptEntry exactly
// once, right after brain.work() resolves - never duplicated, never
// dropped.
function streamingFakeBrain(liveTexts: string[], trailingTexts: string[]): Brain {
  return {
    name: "streaming-fake",
    model: "fake-1",
    async ask() {
      return {};
    },
    async work(_brief, workdir) {
      const now = () => new Date().toISOString();
      const live = liveTexts.map((text) => ({ occurredAt: now(), kind: "text", text }));
      for (const entry of live) emitLiveTranscriptEntry(workdir, entry);
      const trailing = trailingTexts.map((text) => ({ occurredAt: now(), kind: "usage", text }));
      return { transcript: [...live, ...trailing], session: "s1" };
    },
  };
}

test("runAttempts: onTranscriptEntry gets live entries immediately, then exactly the trailing ones once work() resolves", async () => {
  const seen: string[] = [];

  await runAttempts({
    brain: streamingFakeBrain(["live-1", "live-2"], ["usage-at-the-end"]),
    brief: "do it",
    workdir: scratchWorkdir(),
    taskId: "t1",
    judge: greenJudge,
    totalAttempts: 1,
    stopEarlyOnGreen: true,
    onTranscriptEntry: (entry) => seen.push(entry.text),
  });

  // live-1/live-2 arrive exactly once each (not duplicated by the
  // catch-up pass), and the trailing entry - never emitted live - still
  // arrives, in its place at the end.
  assert.deepEqual(seen, ["live-1", "live-2", "usage-at-the-end"]);
});

test("runAttempts: onTranscriptEntry delivers every entry for a brain with no live signal at all", async () => {
  const seen: string[] = [];

  await runAttempts({
    brain: fakeBrain(),
    brief: "do it",
    workdir: scratchWorkdir(),
    taskId: "t1",
    judge: greenJudge,
    totalAttempts: 1,
    stopEarlyOnGreen: true,
    onTranscriptEntry: (entry) => seen.push(entry.kind),
  });

  // fakeBrain() never calls emitLiveTranscriptEntry - its one "text"
  // entry must still reach onTranscriptEntry via the catch-up pass.
  assert.deepEqual(seen, ["text"]);
});

test("runAttempts: a judgement with no verdict stops the loop, whatever the budget", async () => {
  const brain = fakeBrain();
  const result = await runAttempts({
    brain,
    brief: "do it",
    workdir: scratchWorkdir(),
    taskId: "t1",
    judge: async () => ({ kind: "not-verified", reason: "no toolchain" }),
    totalAttempts: 3,
    stopEarlyOnGreen: false,
  });

  assert.equal(brain.calls, 1);
  assert.equal(result.lastJudgement.kind, "not-verified");
  assert.equal(result.lastGate, undefined);
  assert.equal(result.receipts[0].checks, null);
});

// Issue #189: the subscription meters on every receipt, and the one
// threshold that stops an attempt that is already running.

const FRESH_READING = { observedAt: new Date().toISOString(), fiveHourPercent: 7, sevenDayPercent: 64 };

/** A brain that registers a meter source the way the reference adapter
 * does, reports `reported` on every tick, and sits in `work()` until it
 * is asked to pause (or until `holdMs` elapses, so a test can never
 * hang). `pauses` counts how many times it was actually asked. */
function meteredFakeBrain(
  reported: { observedAt: string; fiveHourPercent: number | null; sevenDayPercent: number | null },
  opts: { holdMs?: number } = {}
): Brain & { pauses: number; worked: number } {
  const state = { pauses: 0, worked: 0 };
  return {
    name: "metered-fake",
    model: "metered-1",
    get pauses() {
      return state.pauses;
    },
    get worked() {
      return state.worked;
    },
    async ask() {
      return { costUsd: 0 };
    },
    async work(_brief, workdir) {
      state.worked += 1;
      let paused = false;
      const unregister = registerMeterSource(workdir, {
        reading: () => reported,
        pause: () => {
          state.pauses += 1;
          paused = true;
        },
      });
      try {
        const deadline = Date.now() + (opts.holdMs ?? 2_000);
        while (!paused && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      } finally {
        unregister();
      }
      return {
        transcript: [{ occurredAt: new Date().toISOString(), kind: "text", text: "worked" }],
        session: "metered-session",
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
          quiz: [
            { question: "What changed?", answer: "The thing this test is about." },
            { question: "Why?", answer: "So the write-up is valid." },
            { question: "What should the owner watch?", answer: "Nothing - this is a test." },
          ],
        },
      };
    },
  };
}

test("runAttempts: every receipt records both subscription meters, exactly as the brain reported them", async () => {
  const { receipts } = await runAttempts({
    brain: fakeBrain({ meters: FRESH_READING }),
    brief: "do it",
    workdir: scratchWorkdir(),
    taskId: "t1",
    judge: greenJudge,
    totalAttempts: 1,
    stopEarlyOnGreen: true,
  });

  assert.deepEqual(receipts[0].meters, FRESH_READING);
});

test("runAttempts: a brain that cannot report the meters leaves them null on the receipt, never 0", async () => {
  const { receipts } = await runAttempts({
    brain: fakeBrain(),
    brief: "do it",
    workdir: scratchWorkdir(),
    taskId: "t1",
    judge: greenJudge,
    totalAttempts: 1,
    stopEarlyOnGreen: true,
  });

  assert.equal(receipts[0].meters, null);
});

test("runAttempts: the week past its stop threshold stops the attempt in flight - paused, never judged, never failed", async () => {
  const brain = meteredFakeBrain({ ...FRESH_READING, sevenDayPercent: 93 });
  let judged = 0;

  const result = await runAttempts({
    brain,
    brief: "do it",
    workdir: scratchWorkdir(),
    taskId: "t1",
    judge: async () => {
      judged += 1;
      return { kind: "verdict", gate: { green: true, output: "ok" } };
    },
    totalAttempts: 3,
    stopEarlyOnGreen: false,
    heartbeatIntervalMs: 5,
    pauseRule: { rule: DEFAULT_PAUSE_RULE },
  });

  assert.equal(brain.pauses >= 1, true, "the worker was actually asked to stop");
  assert.equal(judged, 0, "a paused attempt is never handed to a check or to Inspector");
  assert.equal(brain.worked, 1, "the loop stops - no further attempt is started");
  assert.equal(result.meterStop?.usedPercent, 93);
  assert.equal(result.meterStop?.thresholdPercent, 90);
  assert.equal(result.meterStop?.workerStopped, true);
  assert.equal(result.meterStop?.attempt, 1);
  assert.equal(result.lastJudgement.kind, "paused-by-meter");
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0].outcome, "paused-by-meter");
  assert.equal(result.receipts[0].meters?.sevenDayPercent, 93);
  assert.equal(result.receipts[0].checks, null);
});

test("runAttempts: a full 5-hour window never stops an attempt in flight - it runs to its own end", async () => {
  const brain = meteredFakeBrain({ observedAt: new Date().toISOString(), fiveHourPercent: 99, sevenDayPercent: 20 }, { holdMs: 60 });

  const result = await runAttempts({
    brain,
    brief: "do it",
    workdir: scratchWorkdir(),
    taskId: "t1",
    judge: greenJudge,
    totalAttempts: 1,
    stopEarlyOnGreen: true,
    heartbeatIntervalMs: 5,
    pauseRule: { rule: DEFAULT_PAUSE_RULE },
  });

  assert.equal(brain.pauses, 0);
  assert.equal(result.meterStop, undefined);
  assert.equal(result.receipts[0].outcome, "delivered");
});

test("runAttempts: with no pause rule at all, nothing stops - the meters are still recorded", async () => {
  const brain = meteredFakeBrain({ ...FRESH_READING, sevenDayPercent: 99 }, { holdMs: 60 });

  const result = await runAttempts({
    brain,
    brief: "do it",
    workdir: scratchWorkdir(),
    taskId: "t1",
    judge: greenJudge,
    totalAttempts: 1,
    stopEarlyOnGreen: true,
    heartbeatIntervalMs: 5,
    // Every real caller passes this (do.ts/verdict.ts), and it is what
    // makes the loop tick at all - which is where a reading from a
    // brain that reports only through the registry, and nothing in its
    // transcript, is picked up.
    onHeartbeat: () => {},
  });

  assert.equal(brain.pauses, 0);
  assert.equal(result.meterStop, undefined);
  assert.equal(result.receipts[0].meters?.sevenDayPercent, 99, "read on the heartbeat tick, with no entry in the transcript");
});

test("runAttempts: a stale reading stops nothing, however full the week looks", async () => {
  const stale = {
    observedAt: new Date(Date.now() - METER_READING_MAX_AGE_MS - 1_000).toISOString(),
    fiveHourPercent: 99,
    sevenDayPercent: 99,
  };
  const brain = meteredFakeBrain(stale, { holdMs: 60 });

  const result = await runAttempts({
    brain,
    brief: "do it",
    workdir: scratchWorkdir(),
    taskId: "t1",
    judge: greenJudge,
    totalAttempts: 1,
    stopEarlyOnGreen: true,
    heartbeatIntervalMs: 5,
    pauseRule: { rule: DEFAULT_PAUSE_RULE },
  });

  assert.equal(brain.pauses, 0);
  assert.equal(result.meterStop, undefined);
});

test("runAttempts: a brain that registers no meter source is never paused mid-flight, whatever its transcript says", async () => {
  // A reading only ever reaches the Foreman mid-attempt from a
  // registered source, so a brain that registers none cannot be stopped
  // by the pause rule in flight - its reading still reaches the receipt
  // through the transcript, which is what a later start is judged on.
  const brain = fakeBrain({ meters: { ...FRESH_READING, sevenDayPercent: 97 } });

  const result = await runAttempts({
    brain,
    brief: "do it",
    workdir: scratchWorkdir(),
    taskId: "t1",
    judge: greenJudge,
    totalAttempts: 1,
    stopEarlyOnGreen: true,
    heartbeatIntervalMs: 5,
    pauseRule: { rule: DEFAULT_PAUSE_RULE },
  });

  // fakeBrain resolves at once, so the heartbeat may never tick: the
  // round completes normally and the reading lands on its receipt.
  // Either way nothing reads as a failure.
  assert.notEqual(result.receipts[0].outcome, "failed");
  assert.equal(result.receipts[0].meters?.sevenDayPercent, 97);
});

// Issue #184: every receipt names the model that actually ran, as the
// worker itself reported it, plus the declaration the round was started
// under. "default" is gone from both halves - see model.test.ts for the
// invariant itself.
test("runAttempts: a receipt records the model the worker reported, and the declaration behind it", async () => {
  const brain = fakeBrain({ model: "small-5", reportedModel: "small-5-20260202" });

  const { receipts } = await runAttempts({
    brain,
    brief: "do it",
    workdir: scratchWorkdir(),
    taskId: "t1",
    judge: greenJudge,
    totalAttempts: 1,
    stopEarlyOnGreen: true,
    modelChoice: { declaredModel: "small-5", modelSource: "flag" },
  });

  assert.equal(receipts[0].model, "small-5-20260202", "what ran, not what was asked for");
  assert.equal(receipts[0].declaredModel, "small-5");
  assert.equal(receipts[0].modelSource, "flag");
});

// Issue #167: the model connection dropped mid-round and 18 minutes of
// worker time produced no receipt at all - the task's cost stayed at its
// previous value and the daily cap never saw the attempt. Rule 10 says
// unknown spend is never counted as zero, so a crashed attempt leaves an
// unmeasured receipt behind on its way out.
function crashingBrain(message: string): Brain {
  return {
    name: "crashing",
    model: "crashing-1",
    async ask() {
      return {};
    },
    async work() {
      throw new Error(message);
    },
  };
}

test("runAttempts: a brain.work() that throws still hands over an unmeasured receipt, and still rethrows", async () => {
  const handed: Receipt[] = [];

  await assert.rejects(
    runAttempts({
      brain: crashingBrain("API Error: Connection closed mid-response"),
      brief: "do it",
      workdir: scratchWorkdir(),
      taskId: "t1",
      judge: greenJudge,
      totalAttempts: 2,
      stopEarlyOnGreen: true,
      modelChoice: { declaredModel: "small-5", modelSource: "flag" },
      onReceipt: (receipt) => handed.push(receipt),
    }),
    /Connection closed mid-response/
  );

  assert.equal(handed.length, 1, "the crashed attempt's spend must reach the record exactly once");
  const [receipt] = handed;
  assert.equal(receipt.costUnknown, true);
  assert.equal(receipt.costUsd, null, "never $0 - nobody measured it");
  assert.equal(receipt.outcome, "failed");
  assert.equal(receipt.checks, null, "nothing judged an attempt that never finished");
  assert.equal(receipt.task, "t1");
  assert.equal(receipt.attempt, 1);
  assert.equal(receipt.brain, "crashing");
  assert.equal(receipt.declaredModel, "small-5", "the attempt still says what it was started under");
  assert.equal(receipt.modelSource, "flag");
});

test("runAttempts: a crashed attempt's receipt is unmeasured even when usage entries arrived live first", async () => {
  // A streaming worker can report a partial cost before it dies. Taking
  // it would put a KNOWN figure on the record for spend that is in fact
  // unknown - understating it, and clearing a block it must not clear.
  const live = { occurredAt: new Date().toISOString(), kind: "usage", text: JSON.stringify({ totalCostUsd: 0.37 }) };
  const handed: Receipt[] = [];

  await assert.rejects(
    runAttempts({
      brain: {
        name: "crashes-after-reporting",
        model: "crashing-1",
        async ask() {
          return {};
        },
        async work(_brief, workdir) {
          emitLiveTranscriptEntry(workdir, live);
          throw new Error("the container died");
        },
      },
      brief: "do it",
      workdir: scratchWorkdir(),
      taskId: "t1",
      judge: greenJudge,
      totalAttempts: 1,
      stopEarlyOnGreen: true,
      onReceipt: (receipt) => handed.push(receipt),
    }),
    /the container died/
  );

  assert.equal(handed[0].costUnknown, true);
  assert.equal(handed[0].costUsd, null);
});

test("runAttempts: a crashed attempt's receipt still carries the meters its box last reported", async () => {
  const handed: Receipt[] = [];
  const workdir = scratchWorkdir();

  await assert.rejects(
    runAttempts({
      brain: {
        name: "crashes-after-a-tick",
        model: "crashing-1",
        async ask() {
          return {};
        },
        async work() {
          const unregister = registerMeterSource(workdir, {
            reading: () => ({ ...FRESH_READING, sevenDayPercent: 41 }),
            pause: () => {},
          });
          try {
            // Long enough for one heartbeat tick to read the meters.
            await new Promise((r) => setTimeout(r, 30));
          } finally {
            unregister();
          }
          throw new Error("the relay went away");
        },
      },
      brief: "do it",
      workdir,
      taskId: "t1",
      judge: greenJudge,
      totalAttempts: 1,
      stopEarlyOnGreen: true,
      heartbeatIntervalMs: 5,
      onHeartbeat: () => {},
      onReceipt: (receipt) => handed.push(receipt),
    }),
    /the relay went away/
  );

  assert.equal(handed[0].meters?.sevenDayPercent, 41);
  assert.equal(handed[0].costUnknown, true);
});

test("runAttempts: a brain that reports no model per call falls back to its own label, never to 'default'", async () => {
  // The reference worker's own label before issue #184 was literally
  // "default"; a brain still saying that contributes nothing, and the
  // receipt says "unknown" rather than implying a model nobody chose.
  const { receipts } = await runAttempts({
    brain: fakeBrain({ model: "default" }),
    brief: "do it",
    workdir: scratchWorkdir(),
    taskId: "t1",
    judge: greenJudge,
    totalAttempts: 1,
    stopEarlyOnGreen: true,
  });

  assert.equal(receipts[0].model, "unknown");
  assert.equal(receipts[0].declaredModel, null, "nothing declared one");
  assert.equal(receipts[0].modelSource, "default");
});
