# A crashed attempt's spend (issue #167)

## The plan, and the alternative that was rejected

**Chosen:** record the unmeasured receipt from inside `runAttempts`' own
`catch` around the `brain.work()` call (`src/foreman/attempts.ts`), on
the existing `onReceipt` callback, then rethrow unchanged.

Why this one, safest first: that `catch` is the exact boundary the
Client's clarification draws - "every throw from `brain.work()` records
an unmeasured receipt; a failure in Fabrica's own code before
`brain.work()` was ever called records nothing." Everything inside the
`try` is the worker's own call (plus `withHeartbeat`'s relay-gone
rejection, which also fires while that call is in flight); everything
that can fail before it - a missing check command, a line that could not
be cut, a project that moved - is outside `runAttempts` entirely, so it
records nothing *by construction* rather than by a condition that could
be got wrong. It is also the only place that still holds the attempt's
own facts: its number, `startedAt`, the live transcript prefix, the
session, the last heartbeat's meter reading. And both callers
(`do.ts`, `verdict.ts`'s fix round) already wire `onReceipt` to
`recordReceipt`, so one change covers an ordinary round and a fix round
with no new plumbing across the detached-process boundary.

**Rejected:** catching the throw one level up, where the round already
turns an error into a `"task-failed"` event (`task-failure.ts`'s
`recordingFailure`, wrapped around the whole round in `do.ts` and
`verdict.ts`). It looks tidier - one place that handles "the round
died" - but from there the attempt's own facts are gone: nothing at that
level knows which attempt number was in flight, when it started, or what
the worker had already reported, so the receipt would have to be
guessed at or reconstructed from the record. Worse, that wrapper also
catches every pre-`work()` failure, so it would have to *infer* whether
money could have moved; the clarification asks for that distinction to
be structural, not inferred.

## What the unmeasured receipt deliberately does not do

`costUsd` is forced to `null` rather than derived from whatever usage
entries arrived live before the crash. A partial figure would be a
*known* cost on the record, which clears nothing and understates the
real spend; the ruling is that unknown is unknown. (In practice the
reference adapter synthesizes its `"usage"` entry from the terminal
`"result"` line, which a crashed call never produces - so the derived
figure would be `null` nearly always anyway. Forcing it makes that a
guarantee instead of an accident of one adapter's shape.)

## The same shape elsewhere: two worker calls that still lose their spend

Issue #167 and its clarification are about `brain.work()` inside the
attempt loop. Two other calls spend real worker time and still record
nothing when they throw. Both were found while doing this and left
standing on purpose; naming them here so they are known rather than
missed.

1. **A quiz re-check (`src/quiz/recheck.ts`'s `recheckOneTask`).** Its
   `brain.work()` call is wrapped in a `try` whose `catch` returns a
   note - "re-check failed (...), left outdated" - and
   `appendQuizRecheckCost` sits *after* the call, so a re-check that
   crashed mid-run records no `"quiz-recheck-cost-recorded"` event at
   all. This is the closest analogue of #167: a worker call, minutes of
   billable time, and the error is additionally *swallowed*, so the
   spend vanishes with no event anywhere. Fixing it is the same
   three-line shape (an unmeasured cost entry before the note is
   returned), but it is a different event and a different ledger slot
   from a `Receipt`, so it wants its own decision.
2. **The clarifying step (`src/foreman/ask.ts`'s `registerAndAsk`).**
   `brain.ask()` throwing appends `"ask-failed"` and no
   `"ask-cost-recorded"`, so the same gap exists there in principle.
   Deliberately *not* changed, and not merely for scope: today's live
   failure of that call is the reference adapter's credential gap, which
   throws immediately having spent nothing at all. Recording an unknown
   cost for it would halt every new task under a cap until someone ran
   `fabrica cost` - a factory-wide block triggered by a misconfiguration
   that cost nothing. The asymmetry with `work()` is the point: by the
   time a `work()` call dies, minutes of billed time have already
   passed, and nobody outside can say how much.

## Known shape, not fixed here: the ledger keys on (task, attempt)

`spend.ts`'s `ledger()` keeps the **first** receipt it sees for a given
`(task, attempt)` pair and ignores later ones. `do.ts`'s
`runProductionRound` always numbers from attempt 1 (it passes no
`startAttempt`), so a task whose answered round crashed and is then
resumed again with `fabrica answer` produces a second receipt for
attempt 1. The crash's unmeasured receipt wins, and the retry's real
measured figure is dropped from the day's total.

That is the safe direction and was left alone on purpose: the block
persists until `fabrica cost` records a figure the owner vouches for,
and `recordCost` covers every still-unknown attempt of the task at once.
The opposite rule - letting a later known cost overwrite an earlier
unknown one - would clear a block for spend nobody measured, which is
exactly what rule 10 forbids. The shape pre-dates this change (receipts
have landed mid-round via `onReceipt` since issue #11, and a round can
throw after one lands); this change only makes it easier to reach.
