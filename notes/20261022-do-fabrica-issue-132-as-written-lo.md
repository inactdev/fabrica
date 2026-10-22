# Timer-driven tests: wait for the Nth tick, never sleep and count

Issue #132 (Client ruling 2026-10-13) was one flaky test, but the shape
it names recurs across this project and is worth recognising on sight:

```ts
// load-dependent: how many ticks fit into 200ms of a busy box?
await new Promise((r) => setTimeout(r, 200));
land the outcome;
assert.ok(ticks.length >= 3);
```

The assertion is really measuring the machine. On the worker box the
issue describes (2 CPUs, whole suite at once) `waitForAskOutcome`'s
version failed 3 runs in 6 with "got 2", and passed 5/5 when run alone.

**The fix shape**, with no change to the code under test: let the thing
being counted *end the wait*. Poll until the Nth tick has really arrived
(the local `waitFor(condition, ceiling)` helper every test file in
`src/cli/` already carries — `await-command.test.ts`, `watch-command.test.ts`,
and now `wait-for-ask-outcome.test.ts`), then land the outcome, then
assert. A loaded machine takes longer; it does not fail. The ceiling is
only there so a genuine regression fails instead of hanging, and is never
the quantity being measured.

Two further details that are easy to get wrong:

- **Latch the call settling** (`let ended = false` + a `.then` on the
  promise) and put it in the `waitFor` condition. Without it, the exact
  regression the test guards against — the function deciding on its own
  cutoff, so no further ticks ever come — makes the test sit out the
  whole ceiling instead of failing in milliseconds, and the failure
  message cannot tell you which of the two things went wrong.
- **Land the outcome before asserting.** `waitForAskOutcome` loops
  forever by design; a failed assertion that aborts before the event is
  appended leaves that loop running and the test process never exits.

Verified for real on this change, not reasoned about: a 50ms cutoff
spliced into `waitForAskOutcome` makes the repaired test fail in 57ms
with "got 1 notices before it stopped waiting on its own", and the
repaired test passed 5 runs out of 5 with twelve busy loops saturating
the box.

## Same shape, still standing (not touched by #132)

- `src/foreman/attempts.test.ts` — "onHeartbeat fires repeatedly while
  brain.work is in flight": `slowBrain(300)` with
  `heartbeatIntervalMs: 10`, asserting `beats.length >= 3`.
- `src/foreman/attempts.test.ts` — "a throwing onHeartbeat loses the
  beat, never the task": `slowBrain(40)` with `heartbeatIntervalMs: 5`,
  asserting `beats >= 2`.

Both are the same "count ticks inside a real sleep" construction, with
roughly 10x and 4x headroom respectively (vs. the ~2x that made #132's
test flake), which is presumably why neither has been seen failing yet.
Either would be repaired by having `brain.work()` resolve on the Nth
heartbeat rather than after a fixed delay.

A near relative, deliberately left alone: tests that sleep and then
assert something did **not** happen (`await-command.test.ts`'s
"heartbeats alone never trigger an exit", `attempts.test.ts`'s
"heartbeat stops the instant brain.work resolves"). A slower machine only
gives the wrong behaviour more chances to appear, so load can make those
stricter, never spuriously red.
