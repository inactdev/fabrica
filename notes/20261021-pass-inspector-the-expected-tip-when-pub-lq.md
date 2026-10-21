# A rebased branch is published with a lease, not a blind force

Inspector publishes a green branch (inspector#18); a fix round's
host-side rebase (issue #235) rewrites that branch's commits, so the
publish is a *forced* push. Fabrica now hands Inspector the one fact only
Fabrica knows — which commit origin's copy of the branch is expected to
still be at — as `inspector run -expected-tip <sha>`, so Inspector can
push with `--force-with-lease` (inspector#53). Client rulings, 2026-10-21.

## The three rules, and which clarification settled each

- **The sha is `origin/fabrica/<taskId>`, not the local branch tip.**
  Force-with-lease compares against the *remote*, so that is what the
  lease has to name. The two diverge whenever the branch moved locally
  since it was last published (a red or refused round's commit). When
  they differ, both go on the record (`"inspector-called"`'s
  `expectedTip` + `localTipBeforeRebase`) and the remote one is passed.
- **Omitted, never empty, when there is nothing to lease against.** A
  task branch nothing ever published has no `refs/remotes/origin/...`;
  the flag is simply left off and the publish behaves exactly as it did
  before. This must never add a new way for a publish to fail — which is
  why every git read behind it (`src/line/rebase.ts`'s `commitAt`,
  `branchTip`) answers `null` rather than throwing.
- **Only when the tip actually moved**, not merely when the rebase step
  ran. An unchanged tip is a fast-forward and needs no lease.

## Where the two tips have to be read, and why only there

`src/line/rebase.ts` reads both into `RebaseOutcome.tips` *between* its
`git fetch origin` and the `git rebase` — the only moment both are true
at once. Afterwards the branch has been rewritten, and any later fetch
could have moved origin's copy, so "read it at publish time instead"
cannot work: it would lease against whatever the remote looks like now
rather than what the rebase started from. Nothing in `src/line` uses the
value; `src/foreman/fix-rebase.ts`'s `publishLeaseAfterRebase` is the
only reader, and the policy ("did it move", "is there a remote copy")
stays on the foreman side like every other rebase decision.

## Why the lease reaches `inspectorJudge` as a thunk

On the conflict path the rebase is still *stopped* when `prepareRound`
builds the round's judge; it only finishes later, inside `runAttempts`'
`beforeCommit`. So `prepareRound({ publishLease: () => lease })` is asked
at each handoff rather than resolved up front. Resolving it eagerly would
silently give the conflict path no lease at all — the one path where a
rebase most obviously happened.

`verdict.ts` is the only writer of that variable: set when the rebase
completes (in one go, or once the host finishes a stopped one), cleared
on every path that undoes it (`give-up`, and the round-ended abort after
the attempt loop). An aborted round never reaches Inspector anyway, so
the clearing is belt-and-braces rather than the thing that protects it.

## Same shape elsewhere, deliberately left alone

`src/foreman/attempts.ts` rewrites the branch's last commit too — a
fallback-message commit is `--amend`ed by the next attempt
(`unpublishedFallbackCommit`). It needs no lease because such a commit is
never handed to Inspector, so it is never published; that invariant, not
a flag, is what keeps the amend safe. If an attempt with an invalid
write-up ever became publishable, this is the second site that would
need the same treatment.

## The flag's description is Fabrica's, and the sync carries it

`src/inspector/consumer-contract.json` is the source (issue #109);
`.github/workflows/sync-inspector-contract.yml` replaces Inspector's
`cmd/inspector/testdata/fabrica-consumer-contract.json` wholesale from
it. So the description written here is the one both sides end up with
once that sync merges — Inspector's side is never hand-edited to match.
