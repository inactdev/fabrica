# A test about heartbeats never counts ticks against a fixed sleep

Issue #133 (Client ruling 2026-10-13, low priority), the same flake
shape as issue #132 before it.

`src/foreman/attempts.test.ts`'s heartbeat tests used to run a worker
that slept a fixed number of milliseconds and then assert that at least
N beats had arrived. That assertion reads the machine, not the code: on
a loaded two-core box running the whole suite at once, two beats out of
an expected eight came back as one, and the test failed for a reason
that had nothing to do with the heartbeat.

The settled shape, now used in both files:

- The slow thing is **held open by the test** until the beats the test
  is about have really landed, then released from inside the callback
  that counts them. No count depends on how many ticks a loaded machine
  fits into a stretch of wall-clock time.
- There is still a ceiling (`waitFor`, 20s), and it is **only** so a
  genuine regression fails the test instead of hanging it - it is never
  what is being measured. Verified by hand: with `withHeartbeat`'s tick
  patched to stop its interval on a throw, the test fails with its own
  message after the ceiling rather than waiting forever.

`src/foreman/attempts.test.ts`'s `heldBrain()` and
`src/cli/wait-for-ask-outcome.test.ts`'s `waitFor()` are the two worked
examples; copy one rather than reaching for a real sleep.

## Same shape, still standing elsewhere

Both have far more margin than the one that failed, and neither has been
seen failing, so they were left alone - but they are the same kind of
assertion and would be fixed the same way:

- `src/foreman/inspection.test.ts`, "Inspector handoff records heartbeats
  while awaiting a verdict": a 35ms `inspect()` sleep against a 5ms
  interval, asserting only that *some* heartbeat landed (1 of ~7).
- `src/cli/docker-daemon.test.ts`, "says what it is waiting on while it
  waits": `progress.length >= 2` out of ~9 progress lines expected inside
  a 1s wait.

Deliberately not the same shape, and fine as they are:
`src/foreman/ci-checks.test.ts`'s heartbeat test (the fake reader calls
`onTick()` an exact number of times), and
`src/foreman/attempts.test.ts`'s "heartbeat stops the instant brain.work
resolves" (it compares a count against itself, so load can only make it
pass more easily, never fail spuriously).
