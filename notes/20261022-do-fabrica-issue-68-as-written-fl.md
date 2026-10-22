# Issue #68: a round's receipts, gate declarations and evidence are stored once

Task: `do fabrica issue #68 as written`, 2026-10-22, with three Client
clarifications (quoted in the issue thread): the delivery's `evidence`
becomes a pointer to the receipt plus a short excerpt; a gate declaration
is keyed by gate name with the newest per gate winning; and existing
records keep reading correctly through read-side tolerance, never a
rewrite.

## The design that was picked, and the one that was rejected

Picked: **write only the round's own data, reconstruct the cumulative
view on read.**

- A `"delivered"` event's `details.receipts` is this round's receipts
  only. `queries.ts`'s `receiptsOf` walks every event that carries a
  receipt - each attempt's own `"receipt-recorded"` plus every
  `"delivered"` event - and keys by attempt number, **latest wins**. An
  old cumulative record de-duplicates to the same list it always
  produced, so nothing on disk needs rewriting (clarification c).
  Latest-wins rather than first-wins matters for one real case: the
  commit-failure path mutates its last receipt's `outcome` to `"failed"`
  *after* that receipt's own `"receipt-recorded"` event was appended, so
  the delivered event's copy is the corrected one.
- The cumulative *attempt count* a delivery reports is one number, not an
  array: `details.attemptsSoFar`. `fabrica log`'s delivered line falls
  back to `receipts.length` when it is absent, which is exactly what an
  old record gives it.
- A round's own gate declarations ride on the same event as
  `details.gateDeclarations` (an array: a fix round that hands its worker
  more than one stopped rebase makes more than one). The delivery's
  `gateChanges` is merged from every round's declarations, read back from
  the record.
- "This round's" means every pass of it. `recordRoundResult`'s `ctx`
  therefore splits what used to be one `priorReceipts`/`priorGateChanges`
  pair into two: `priorReceipts`/`priorGateDeclarations` (the task's
  earlier *rounds*, which only count toward `attemptsSoFar` and the
  merged declaration) and `roundReceipts`/`roundGateDeclarations` (this
  round's earlier *passes*, which also land on its event). A fix round
  that conflicted twice records both of its passes on one delivery.

Rejected: **keep the cumulative arrays on each event and prune the record
file periodically.** It leaves the duplication in place and adds a writer
to a file whose whole value is that nothing ever rewrites it
(`src/record/`'s append-only proof). The cost this issue is about -
`src/record/read.ts` parsing every byte for every query - would come back
the moment pruning fell behind, and a pruner is a second thing that can
disagree with the reader.

## Gate declarations are keyed by the gate they name

`mergeGateDeclarations` now takes the whole list of per-round declarations
(oldest first) instead of folding a new one into an already-merged string.
Keying needs a gate name, and a worker's declaration is free prose
(`BrainWorkResult.gateChanges`), so `gateNamesIn` finds the path-like
tokens in it - a lowercase 2-8 character extension, optionally under
directories, which covers `check.sh`, `CONTRACT.md`,
`contract/rule9.test.ts`, `.github/workflows/rule9-gate.yml` and rejects
prose like `e.g.` or `1.2.3`.

This is deliberately the only place in Fabrica that reads anything out of
a worker's prose, and it is written to fail **safe**: a false gate name
only ever keeps an older declaration alive next to a newer one (the
cumulative diff still contains that change, so reporting it is correct);
it can never drop one. Rule 9's enforcement does not depend on it at all
- that lives in `.github/workflows/rule9-gate.yml` and reads the pull
request's real file list, never Fabrica's output.

A declaration naming no path at all lands in one shared unnamed slot,
newest wins - bounded like every other key.

## `evidence` points at the receipt

`delivery.ts`'s `checkEvidence` renders the pointer plus the first 5 and
last 15 lines of the output (the tail is the larger half for the same
reason `gateForRecord` keeps the tail: a check says what failed at the
end). The receipt's `checks.output` and the delivery's `evidence` used to
be byte-identical strings, both capped by `gateForRecord`, so nothing is
lost that was not already stored.

The one consumer that genuinely needed the full text is
`queries.ts`'s `redPublishedChecksOf` (issue #267), which hands a fix
round's worker what GitHub found: it now reads the round's last receipt
with a `checks` value and falls back to `delivery.evidence` only for a
record written before this change.

## Same shape elsewhere

Two other places store a whole receipt list on an event and were checked:

- `src/foreman/inspection.ts`'s `InspectionOptions.receipts` would put the
  same list on an `"inspection-finished"` event, but no production caller
  passes it (`judge.ts`'s only call site passes `prTitle`/`prBody` alone),
  so there is nothing to duplicate there today.
- `src/foreman/fix-rebase.ts`'s `deliverRebaseConflict` writes its own
  `"delivered"` event and was carrying the cumulative list; it takes the
  round's own receipts and `attemptsSoFar` now, like every other delivery.

`src/foreman/spend.ts`'s ledger and `src/foreman/model.ts`'s
`modelFromEvents` already de-duplicated by attempt number across both
event shapes, so both read the new shape unchanged.

## One existing test encoded the old shape

`src/foreman/delivery.test.ts`'s three evidence tests pass no attempt
number, so they exercise `checkEvidence`'s "cannot name a receipt"
fallback and still assert exactly what they always did - deliberately
left alone, since that fallback is the promise that evidence is never
*less* than it was. `src/foreman/fix-rebase.test.ts` had one assertion
that read the cumulative list straight off the event
(`latestDeliveredDetails(...)?.receipts?.length === 4`); it now asserts
the per-round shape (`[3, 4]` plus `attemptsSoFar === 4`). Its
surrounding claim - both conflict passes are on the record as real
attempts with their own receipts - is unchanged and still proven by
`receiptsOf` two lines above it.
