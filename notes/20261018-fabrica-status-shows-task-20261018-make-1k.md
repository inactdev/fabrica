# A recorded failure has to survive whatever lands after it

## The report

`fabrica status` and the live view both showed a task as **working** at
about 16:07Z when the last thing on its record was a `task-failed` event
at 15:52:33Z. Both surfaces derive that word from the same function,
`src/foreman/queries.ts`'s `stateOf`, so whatever went wrong went wrong
there.

## Why `stateOf` could say "working" after a failure

`stateOf` is a single forward pass in which each event overwrites
`state` in place: the last event that names a state wins. `task-failed`
sets `"failed"`, but any later event that names a live state —
`work-started`, a finished `check-run`, `inspector-called`,
`inspection-finished`, `inspection-skipped`, `answers-given` — overwrote
it again, with nothing in the pass that knew a failure had already been
recorded.

Nothing a round does **in its own process** can land after its
`task-failed`: that event is appended from `recordingFailure`'s catch
block (`src/foreman/task-failure.ts`), which sits at the top of the
round's stack, and the heartbeat intervals around `brain.work()` and the
Inspector call are both cleared in a `finally` before it. So anything
that does land afterwards came from somewhere else — a second process
holding the same task id (a resume or fix round the Client started, or a
duplicate of one), or a straggler from a round on its way down. The pass
treated all of those as proof of a live worker.

That is the same failure mode issue #203 already ruled on for
`stopped-by-owner` ("whatever it still manages to append on its way down
… must never move the task back to looking alive"), applied to the
failure case, which had no such protection.

## The rule now

A recorded failure (`task-failed`, `ask-failed`, or a `cap-refused` that
refused the task's very first start) is absorbing. Three event names,
and only those three, take a task back out of it:

- `verdict-recorded` — the Client ruled. `accept`/`wrong` close it;
  `fix` starts a new round.
- `answers-given` — the Client answered a clarifying question, which
  resumes the task.
- `delivered` — a round genuinely finished and there is something to
  rule on.

The first two are safe to trust because **both are written in the
foreground, by the command the Client himself ran, before any round is
handed to a detached process** (issue #123's split:
`recordVerdictDecision` / `recordAnswerDecision`). Every genuine restart
of a failed task therefore puts one of them on the record ahead of that
round's own events, so no real resume is missed. The third is safe
because a round that delivers has not thrown, so a `delivered` event is
never a dying round's straggler — and swallowing one would hide a
delivery the Client still has to rule on.

## Alternatives rejected

- **Make the failure fully absorbing, the way `stopped-by-owner` is**
  (only `verdict-recorded` escapes). Rejected: two rounds can hold the
  same task id at once — the live view's `/review` page and
  `fabrica verdict` call the same `recordVerdictDecision` +
  `spawnDetachedResume` pair, so a double submit is enough — and if the
  loser records `task-failed` while the winner goes on to deliver, a
  fully absorbing failure would hide that delivery for good.
- **Order the pass by `occurredAt` instead of by position in the
  record.** Rejected: it fixes nothing here (the failure really is the
  last line), and it would make a task's state depend on clocks that are
  not all the host's — the relay writes its own events from inside a
  container.
- **Call `stateOf` correct and blame a stale installed copy.**
  Rejected: the report covers two separately-started surfaces, and the
  guard above is cheap enough that the symptom should be impossible
  either way.
