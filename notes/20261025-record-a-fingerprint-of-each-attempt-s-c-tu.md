# The change fingerprint (patch id) on receipts and deliveries

## The plan, written before any code was changed

Record, per attempt and per pass, a `git patch-id --stable` of the
change the branch holds, taken against the merge-base of the branch and
origin's default branch. Mark on every later pass whether that id is one
the task already stamped, and show both facts in `fabrica status` and
`fabrica log`.

Chosen shape, safest first:

1. `src/foreman/fingerprint.ts` - read-only git, no network, never
   throws. Resolves origin's default branch from the local
   `refs/remotes/origin/HEAD` symref (exactly as `base-standing.ts`
   does), takes `git merge-base HEAD refs/remotes/origin/<default>`,
   pipes `git diff <base> HEAD` into `git patch-id --stable`. Anything
   it cannot answer comes back as `{ patchId: null, reason }` - never a
   throw, never a silent skip.
2. The two record shapes are widened in `src/inspector/types.ts`, the
   established place for Fabrica's own bookkeeping fields, not in
   `contract/surface.ts`.
3. `attempts.ts` stamps the receipt right after the attempt's own
   commit; `round.ts` stamps the delivery once the branch has stopped
   moving for whichever path it took, and attaches the comparison
   against the task's previous pass.
4. `fabrica status` and `fabrica log` render it, and `delivery.md`
   carries it.

## Alternatives weighed and rejected

- **Diff against the task's pinned `baseCommit`** (the fork point
  `line-cut` recorded). Rejected, and measured rather than assumed: with
  a branch rebased onto a moved origin, the patch id taken against the
  pinned base changes (`b330a8e…`) while the one taken against the
  merge-base does not (`1f84653…` before and after). A fingerprint that
  moves when nothing about the change moved is the one thing this
  feature exists to avoid.
- **`git fetch` at stamping time**, so "origin's default branch" means
  the remote's current tip rather than this checkout's last known one.
  Rejected on two grounds. It would put a network call, and a ref
  write, inside what is otherwise a pure report - the same reason
  `base-standing.ts` reads the local symref. And it buys nothing:
  merge-base is monotone, so a newer upstream tip that descends from the
  one already on disk yields the *same* merge-base with the task's
  branch. The only operations that move a task branch relative to
  upstream - cutting the line, and the fix round's rebase - already
  fetch before they do it.
- **Declaring the fields in `contract/surface.ts`.** Rejected: that file
  is a protected path, and a change fingerprint is Fabrica's own
  bookkeeping about its own record, not a new promise about a seam -
  the same reasoning that put `meters`, `declaredModel` and
  `stopped-by-owner` in `src/inspector/types.ts`.

## What the surfaces show, and the one that does not

`fabrica status` marks a delivered line, `fabrica log` marks every
`receipt-recorded` and `delivered` line, and `delivery.md` carries a
`fingerprint:` field. All three render
`src/foreman/fingerprint.ts`'s `describeFingerprint` verbatim, the same
single-wording rule `describeBaseStanding` already follows.

**Deliberately not done: the live view's `/review` page.** The base
standing is shown on both `fabrica status` and that page, from one
function, so the fingerprint is the one fact of this kind that now
exists on only one of the two surfaces. The brief named `fabrica
status` and `fabrica log`; adding a row to the review page is a
self-contained follow-up and `deliveredFingerprintOf` is already
exported from `src/index.ts`, which is the only door that integration
has into Fabrica.

## Composing with the test-map report on the same delivery

`round.ts` and `fix-rebase.ts` now attach two independent per-round
blocks to the same `Delivery`: the test-map report (`withTestMapReport`,
a wrapper taking a delivery and returning a copy) and the change
fingerprint (`...stamp()`, a spread of two fields). They compose one
way round only - the stamp is spread into the object literal *handed
to* the wrapper, not applied to its result:

```ts
const delivery = withTests({ ...buildDelivery(...), ...stamp() });
```

`withTestMapReport` returns `{ ...delivery, tests: report }`, so any
field spread in beforehand survives; doing it the other way would work
too but puts the stamp outside the one call every delivery path already
funnels through. In `delivery.md` the one-line `fingerprint:` sits above
the multi-line `tests:` block, keeping every one-line fact scannable as
a single column.

## Durable facts worth keeping

- `git patch-id --stable` is insensitive to the abbreviation length of a
  diff's `index` lines (checked on git 2.54.0 with `--full-index` and
  `--abbrev=4`: identical ids), so the fingerprint does not drift as a
  repository grows. It IS sensitive to rename detection, which is
  config-driven, so the diff is taken with `--no-renames` pinned.
- `git patch-id` prints nothing at all for empty input. An empty diff is
  therefore recorded as unstamped with a reason, never as a blank id.
- A linked worktree shares `refs/remotes/*` with its project, so the
  fingerprint can be taken entirely inside a ProductionLine's own
  workdir without reaching for the project path.
