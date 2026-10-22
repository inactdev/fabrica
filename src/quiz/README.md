# src/quiz — the quiz, as a thing with a memory

Every accepted task's worker left three questions and answers behind
(`WorkerWriteup.quiz`, issue #98). This module turns that pile into
something the owner can actually be tested on: a question at a time, on a
spaced-repetition schedule, and only while the question is still true.

The live view's `/quiz` page is the surface
(`integrations/live-view/public/quiz.js`); everything below it is here.

## Nothing is stored twice

The record is the only store. A question's words come from its task's own
`delivered` event; everything that has happened to it since is four event
names (declared in `src/inspector/types.ts`, the one place event names
are widened past the ratified set — `contract/surface.ts` is a path
`rule9-gate.yml` protects, and none of this is a new promise about a
seam):

| event | details | means |
| --- | --- | --- |
| `quiz-answered` | `{ index, right }` | the Client marked it |
| `quiz-stale` | `{ touchedBy, files }` | later accepted work may have dated **every** question of this task |
| `quiz-rechecked` | `{ index, outcome, question?, answer?, note? }` | a re-check round ruled on one question |
| `quiz-recheck-cost-recorded` | `{ costUsd, costBasis, startedAt }` | what one re-check round cost |

All four are recorded against the task that spawned the question, so a
question's identity is `taskId` + its position in that task's quiz — which
stays stable even when a re-check rewrites its words.

There is no browser storage anywhere in this feature, and no second
append-only file either. A dedicated `quiz.jsonl` was considered: it would
keep quiz traffic out of `fabrica log` and off a closed task's "last
activity", which is the real cost of the choice made. It was rejected
because it would be a second source of truth with its own reader, its own
corruption story and its own concurrency proof, next to a log that
already has all three and is the project's stated single source of truth.

### Position, not timestamp

`questions.ts` and `staleness.ts` both order events by their **position**
in the record, never by `occurredAt`. A stale mark and the re-check that
answers it — or an accept and the accept after it — can land in the same
millisecond, and that is exactly when "which came first" has to be
right. Timestamps are still what the schedule's arithmetic uses, because
elapsed time is a different question from ordering.

## The repetition scheme (`schedule.ts`)

Client ruling: wrong means eligible again next session; each consecutive
right doubles the wait.

- never answered → due immediately
- **wrong** → due `QUIZ_SESSION_GAP_MS` (30 minutes) later. "Next
  session" needs a boundary, and this is it: a review session is a run of
  marks with no 30-minute gap in it, so a question missed now comes back
  once that run has lapsed.
- **right** → streak + 1, due `min(2^(streak-1), 30)` days later — 1, 2,
  4, 8, 16, then the 30-day cap.
- a **rewritten** re-check resets the schedule (the marks before it were
  about different words). A **confirmed** one does not.

The schedule is derived from the marks on every read rather than stored
as a "next due" number, so it can never drift out of step with what
actually happened — and changing the scheme later re-schedules the whole
history rather than only what is answered from then on.

## Staleness (`staleness.ts`)

On every accept, every **earlier** accepted task whose own delivery
touched one of the same files gets a `quiz-stale` mark, and its questions
stop being asked. Exact path equality, by `Delivery.files`; anything
looser would mark questions on the strength of a resemblance.

Two limits, both of them the point:

- it compares paths, not meaning, so it marks questions that are in fact
  still fine — the re-check confirms those, cheaply;
- it cannot notice a question that went stale for a reason no accepted
  task explains.

Over-marking is the safe direction: a question that may be wrong is
simply not asked until something has looked at it.

## The re-check round (`recheck.ts`)

One `Brain.work()` call per task with outdated questions, in a throwaway
detached-HEAD checkout of `origin/<default branch>`
(`src/line/scratch.ts`). `Brain.ask` cannot do this — it takes no workdir
by construction, so it cannot read the project at all.

The worker answers by writing `quiz-recheck.json` into its own workdir,
which the host reads and validates (`parseRecheckVerdicts`).
`BrainWorkResult` has no free-form structured channel — `writeup` is a
fixed schema for pull request bodies — and widening a ratified contract
shape for this would be the wrong trade when a writable workdir is a
channel every worker already has.

Everything about it fails safe. A task whose project has moved, a
checkout that cannot be cut, a worker that writes nothing readable, a
verdict for a question nobody asked about: each leaves the question
**outdated**, which means it is simply not asked, and a later run tries
again. A run handles at most `QUIZ_RECHECK_MAX_TASKS_PER_RUN` tasks,
oldest acceptance first, and reports what it left.

Money: the round's cost lands on the record against the task whose
questions it re-checked, and `src/foreman/spend.ts` counts it as its own
attempt slot (`QUIZ_RECHECK_FIRST_STEP = -1`; the nth re-check of a task
is `-n`), so it shows in the day's spend rather than being money the
record cannot explain.

`recheckRoomProblem` is the gate, and it is **read-only**: unmeasured
spend, the daily cap, and the pause rule's view of the subscription
meters — never `requireRoomToStart`/`requireMeterRoomToStart`, each of
which appends a refusal event to the task it refuses, and the task being
re-checked is closed, so an event saying it was refused a start would be
a false sentence about it. The per-task cap is deliberately not tested: a
closed task's ceiling was about the work it was allowed to do. The
meters are, because a flat-rate subscription's quota is exactly the
budget a background round that costs no dollars could quietly drain.

## Who calls what, and why not the Foreman

`onTaskAccepted` (mark, then report how many tasks owe a re-check) is
called by the surfaces that record a verdict — `fabrica verdict` and the
live view's verdict route — not by `recordVerdictDecision`. That is the
same layering issue #123 drew for the "fix" round: the Foreman records
the ruling, and everything that follows from it in the background belongs
to the layer that has a process to spawn. A library caller using
`Foreman.verdict` directly therefore marks nothing and starts nothing,
exactly as it starts no fix round.

`recordQuizAnswer` is the Client's own write. It refuses a question this
record has never held, and a question a re-check retired; a question that
went *outdated* while it was on screen is still marked, because he
answered the question he was shown and the mark is about him.
