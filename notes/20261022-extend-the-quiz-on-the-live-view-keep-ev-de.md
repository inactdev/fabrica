# Quiz review mode on the live view (spaced repetition + staleness)

Written before the change, kept as the design record.

## What was asked

Keep every quiz question from every accepted task; add a review mode on
`/quiz` that asks a random question, reveals the answer, takes a
right/wrong mark, and schedules the next showing from those marks. A
question may only be asked while it is still true: a later accepted task
touching any file the question's task touched marks it "may be
outdated", and it stops being asked until a cheap worker round re-checks
it against current master and confirms / rewrites / retires it. The task
that spawned a question and the date stay on the card. The record - not
browser storage - holds all of it.

Clarifications given: open straight into review mode (full list behind a
toggle); re-check automatically on each accept, no schedule and no
button; wrong means eligible again next session and each consecutive
right doubles the wait (1, 2, 4, 8 ... capped at 30 days); outdated and
retired questions stay visible, marked, never asked.

## Where the state lives, and why there

`events.jsonl` - the record's own append-only log - with the event
attributed to the task that spawned the question. Three new names, added
in `src/inspector/types.ts` (the one place event names are widened past
the ratified set; `contract/surface.ts` is a CI-protected path and this
is Fabrica's own bookkeeping, not a new promise about a seam):

- `quiz-answered` - `{ index, right }`. One per mark.
- `quiz-stale` - `{ touchedBy, files }`. Marks *all* of that task's
  questions as may-be-outdated; file overlap is a task-level fact.
- `quiz-rechecked` - `{ index, outcome, question?, answer?, note? }`.

Plus `quiz-recheck-cost-recorded` for the money. Everything the page
shows is derived from those plus the `delivered` event's write-up, every
read. Nothing is stored twice.

Ordering within all of it is by **position in the record**, never by
`occurredAt`: a stale mark and the re-check answering it, or two
accepts in a row, routinely land in the same millisecond, and that is
exactly when "which came first" has to be right. (Both of those were
real bugs caught by the first test run, not hypotheticals.) Timestamps
are still what the schedule's arithmetic uses.

### Alternative rejected

A dedicated `recordHome/quiz.jsonl`. It would have kept quiz traffic out
of `fabrica log`/`status` and off a closed task's "last activity", which
is the one real cost of the choice made. Rejected because it would be a
second source of truth with its own reader, its own corruption story and
its own concurrency proof, next to a log that already has all three and
is the project's stated single source of truth. Honest noise on the
record beat a parallel store.

Also rejected: picking the question server-side. `/quiz` polls at 2Hz, so
a server-chosen random question would reshuffle under the Client's thumb.
The server sends every question with a computed `askable`/`dueAtMs`, and
the page holds the one it picked until it is marked.

## The repetition scheme

`src/quiz/schedule.ts`, pure, tested on its own:

- never answered -> due immediately
- wrong -> due `QUIZ_SESSION_GAP_MS` (30 minutes) later. "Next session"
  needs a boundary and this is it: a review session is a run of marks
  with no 30-minute gap in it, so a question missed now comes back once
  that run has lapsed.
- right -> streak+1, due `min(2^(streak-1), 30)` days later (1, 2, 4, 8,
  16, then the 30-day cap).
- a `rewritten` re-check resets the schedule: answers recorded before it
  were about different words. `confirmed` does not reset.

## The re-check

`src/quiz/recheck.ts`, run in a detached process spawned by whichever
surface recorded the accept (`fabrica verdict`, the live view's verdict
route) - the same split issue #123 drew: the foreground records the
decision, the background runs the round. The library-level
`recordVerdict` deliberately does NOT spawn it, so a contract test's
`verdict(id, "accept")` still calls its fake brain exactly as often as
it always did.

The staleness marking is called from those same two surfaces
(`onTaskAccepted`), not from inside `recordVerdictDecision`. That keeps
the dependency one-way - `src/quiz` reads `src/foreman`, never the
reverse - which matters because the re-check needs `networkPolicyFor`,
`costFromTranscript` and the spend readers. Putting the call inside the
Foreman would have made the two modules import each other in a cycle.
The cost: a library caller using `Foreman.verdict` marks nothing, which
is exactly what it already does about the `fix` round.

It needs the project's code at current master, which means a workdir,
which means `Brain.work` (`Brain.ask` takes no workdir by construction).
`src/line/scratch.ts` is the new, deliberately tiny thing that gives it
one: a detached-HEAD `git worktree` at `origin/<default branch>` under
`recordHome/scratch/<label>/worktree`, built on `src/line`'s existing
safety primitives (`requireRepoRoot`, `fetchOriginDefaultBranch`,
`requireLinkedWorktree`) and removed the same proven way
`destroyProductionLine` removes a line. It is not a ProductionLine and is
not called one: no task branch, no commit, no delivery, and nothing under
`recordHome/tasks/`, so it can never show up as a phantom task the way
issue #81's blocked-edit bucket did.

### Alternative rejected

Cutting a real `ProductionLine` for the re-check. Rejected on two counts:
`createProductionLine` writes `recordHome/tasks/<id>/worktree` (so every
re-check would leave a task folder the live view lists as a task) and it
creates a `fabrica/<id>` branch that teardown deliberately leaves behind
(so every re-check would litter the Client's repository with a branch).

The worker returns its verdicts by writing `quiz-recheck.json` into that
workdir, which the host then reads and validates. `BrainWorkResult` has
no free-form structured channel - `writeup` is a fixed schema - and
inventing one would mean widening a ratified contract shape for a
feature that does not need it. A writable workdir is the channel every
worker already has.

## Cost

A re-check spends real money, so it is recorded: `quiz-recheck-cost-recorded`,
counted by `src/foreman/spend.ts` as its own attempt slot
(`QUIZ_RECHECK_STEP = -1`, mirroring `CLARIFYING_STEP = 0`) against the
question's own task. So it shows in `fabrica status`'s daily figure and
in that task's cost, rather than being money the record cannot explain.
Before running anything, `recheck.ts` checks for room against the caps
with a read-only check of its own - never `requireRoomToStart`, which
would append a `cap-refused` event to an already-closed task.

A run re-checks at most `QUIZ_RECHECK_MAX_TASKS_PER_RUN` (3) tasks,
oldest stale mark first, and says on `cli.log` what it left for next
time; any later accept picks the remainder up, since the run re-derives
every outstanding outdated question from the record rather than only the
ones that accept just marked.

## The one thing deliberately not gated on identity

`POST /api/quiz/answer` does not require the `Tailscale-User-Login`
header the verdict/answer/stop routes do. Those spend money or close
tasks; a quiz mark only moves a spaced-repetition clock, the server is
loopback-only either way, and requiring the header would make review
mode unusable on the machine the live view actually runs on (`fabrica up`
opens `127.0.0.1:7777` in a browser, where no Serve proxy adds it). The
cost of the choice: a chat agent with Bash could skew the Client's own
schedule. It would be visible on the record, and it buys nothing else.

## Why this branch and "model per row" collided in one spot only

`integrations/live-view/record-view.ts` is the single projection every
live-view page polls through, so any two changes that add a column and a
page both land in its one `import { ... } from "../../src/index.ts"`
block. That is the whole of the overlap between this branch and the
"record the real model per attempt" change: that side added
`describeModel`/`modelFromEvents` for `workerLabel`'s model half, this
side added `describeInterval` for `getQuiz`'s schedule phrase, and the
two live in different functions that never read each other's data.
Resolved by keeping both names in the import list and nothing else -
both features' own code was already side by side in the file.

### Alternative rejected

Re-deriving the quiz's interval phrase inside `record-view.ts` (dropping
the import, and with it the conflict surface) would have removed the
collision for good, but it would duplicate `src/quiz/schedule.ts`'s
wording in a second place, which is exactly the "two surfaces word one
fact differently" failure the rest of this file avoids by importing
`describeMeters`/`describeTaskCost`/`describeBaseStandingOf` rather than
re-wording them. A one-line import conflict every few merges is the
cheaper cost.
