# A fix round's rebase conflict is one round now, not two

Supersedes the two-round conflict path issue #235 shipped (see
`notes/20261018-do-fabrica-issue-235-as-written-closing-py.md`, whose
other facts about the git still hold). Client ruling, 2026-10-20.

## The shape, and what must not come back

A conflicting rebase is left **stopped** and handed to that same round's
worker, with the Client's note and the conflicted file list in one brief.
The host stages the resolution and continues the rebase; a later stop of
the same rebase goes back to the **same warm worker in the same round**,
up to `MAX_REBASE_STOPS_PER_ROUND` (5). `inspection-red` only when
markers survive or the ceiling is passed — and the rebase is aborted
first, every time, so the branch is provably back at its own last commit
with a clean tree before anything is delivered.

The replaced design — report the first conflict with no worker run, and
hand it over only in the round the Client ruled next — **must not come
back**: it cost him a whole round to say nothing a worker could not
already be told, and it made a round's shape depend on reading whether
the previous delivery happened to be a conflict report. Nothing branches
on that any more; `DeliveredDetails.rebaseConflict` survives as
bookkeeping only. `rebaseOntoOriginDefault`'s `onConflict: "abort"` mode
went with it (a conflict always stops now; `abortRebase` is the one way
back).

## Why the hand-back loop is `verdict.ts`'s, not `runAttempts`'

Each pass over a stopped rebase is its own `runAttempts` call — one
attempt, `initialSession` carrying the warm session, attempt numbers
continuing past the passes already made. The alternative (a "rework"
return from `beforeCommit`, looping inside `runAttempts`) was rejected on
two counts worth remembering before anyone tries it again:

- it puts a second, uncounted loop inside CONTRACT rule 3's counted retry
  loop, which is the one loop in this codebase that exists to be exactly
  as long as it says;
- it would need per-`work()`-call receipt bookkeeping duplicated inside
  that loop, and rule 10's spend is only ever derived from the record —
  an extra worker call with no `Receipt` is spend that no cap can see.

Looping from the caller gets both for free: `spendLimitsFor` is re-read
per pass, so a per-task cap binds *between* passes, and a cap or meter
stop ends the round instead of calling the worker again.

## Sharp edges

- **A stopped rebase must never outlive its round.** Three exits, all
  aborting: `continueStoppedRebase` (markers left, ceiling passed), a
  post-loop check in `runFixRound` for a round that ended underneath one
  (`"round-ended"` — a cap stop; the report says plainly that the
  conflict is not what stopped the round), and the `finally` for a round
  that threw (`"round-failed"`). `rebaseOntoOriginDefault` refuses
  outright if it ever finds one in flight, so a leak is loud, not
  silent — but the next round is the wrong place to discover it.
- **Abort before delivering, not after.** A conflict delivery's `files`
  comes from `diffFiles` against the original fork point and its text
  promises nothing was rewritten; both are only true once the abort has
  happened. Anything that adds a new way to end such a round has to keep
  that order.
- **`attempts.ts`'s meter-pause path still commits mid-rebase.** It
  commits whatever the worker had done, unconditionally; during a stopped
  rebase that lands on the detached HEAD and the abort then discards it,
  so its "kept in this commit, unreviewed" wording overstates what
  survives. Left standing deliberately: the only alternative is
  committing conflict markers onto the branch, which is worse, and the
  honest fix is wording in a module this change did not touch. Nothing
  else in the loop commits while a rebase is in flight (a
  `rebase-conflicted` judgement preempts the ordinary commit).
- **No write-up commit on the conflict path.** `finishRebase`'s
  `git add -A` + `--continue` folds the worker's whole working tree into
  the replayed commit, which keeps its *original* message, so the round's
  own `commitWorktreeChanges` finds nothing staged and no-ops. The
  write-up still reaches the reviewer as the pull request's title and
  body (`inspectorJudge` uses the round's `finalMessage`).
- **Type-only imports keep `delivery.ts` and `judge.ts` free of the
  rebase policy.** Both need `ConflictReportReason`, which lives in
  `fix-rebase.ts` — which imports `buildRebaseConflictDelivery` back out
  of `delivery.ts`. `import type` is erased, so the runtime dependency
  stays one-way; the delivery's wording takes the stop *count* as data
  rather than importing the ceiling constant.
