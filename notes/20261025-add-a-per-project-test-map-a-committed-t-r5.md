# A per-project test map (`tests.map`)

## Where the seams actually were

Three places already existed and were exactly right for this, which is
why the change is as small as it is relative to what it does:

- `src/foreman/touched-tests.ts` documents itself as "the one place that
  builds the brief a worker actually receives", and all three
  brief-building paths (`do.ts`, `answer.ts`, `verdict.ts`) already go
  through it. One function signature grew two optional fields.
- `src/foreman/round.ts` is the one place a delivery is built, validated,
  rendered and recorded, for every outcome (issue #182).
- `src/cli/render.ts` already had the `*FromEvents` reader pattern
  (`projectFromEvents`, `prUrlFromEvents`, `checksSummaryFromEvents`),
  each latest-wins over the events a caller already fetched.

## Two conflicting standing rulings, resolved by supersession

Issue #142's `ONLY_TOUCHED_TESTS_NOTICE` tells a worker **not** to run
the project's whole suite ("the project's own check runs in full after
you finish"). This task's ruling is mapped tests first, then **the whole
suite as `check.sh` runs it today**. Those are opposite instructions.

A brief carrying both is one a worker could satisfy either way, so the
test-map notice *replaces* it whenever the project commits a `tests.map`
(`withStandingQuestion`'s `testMap` option wins over `onlyTouchedTests`).
Committing the file is the project's own opt-in; a project that wants the
old behaviour simply has no map. Worth knowing before adding a third
conditional notice: the resolution is one `if`, in one place, and a
fourth notice should be resolved there too rather than at a brief
builder.

## The brief cannot name a first round's tests, and must not pretend to

"Every brief names the tests the task's touched files map to" is only
satisfiable where the touched files exist. A first round (and a round
resumed from questions) has touched nothing, so its notice carries the
lookup rule and no list — naming a list derived from a diff that does
not exist is exactly the silent guess CONTRACT rule 4 forbids. A fix
round's branch does carry a diff (`diffFiles(project, branch,
roundBaseCommit)`, re-read per pass because a rebase can move the base),
so its worker is handed the concrete tests and the concrete unmapped
files.

This also keeps brief size bounded independently of map size: the map
itself is never inlined into a brief. Fabrica's own is 321 entries.

## Neither new field went into the contract

`Delivery.tests` is widened in `src/inspector/types.ts` and
`WorkerWriteup.testsRun` in `src/brain/types.ts` — the two established
widening seams — for the reason `AGENTS.md` already records about
`check-run`'s second firing: `contract/surface.ts` is a path
`rule9-gate.yml` protects, and a project's own bookkeeping about its own
test suite is not a new promise about a seam.

`WorkerWriteup` had only ever been re-exported from the contract by
`src/brain/types.ts`, so widening it there reached every reader in `src/`
(`pr-body.ts`, `attempts.ts`, both adapters) with one edit. `src/index.ts`
now re-exports the widened one instead of the contract's.

A useful accident of the existing design: `WRITEUP_OPTIONAL_STRING_FIELDS`
is consumed *programmatically* by both OpenAI-shaped adapters
(`writeupOptionalStringFields` in their job payload), so adding a name to
that list is all those adapters needed. Only the two hand-written JSON
Schemas needed a declared property, and only because both set
`additionalProperties: false`. `testsRun` is deliberately absent from
`pr-body.ts`'s `ADDITIONAL_BULLETS`, so it never reaches a pull request
body — the same choice `quiz` makes, for the same reason: its reader is
the Client, on the delivery.

## Glob matching is hand-written on purpose

`path.matchesGlob` exists in Node 22+ but is still flagged experimental.
`src/testmap/glob.ts` is ~40 lines and pins the semantics the format
documents; a matcher whose rules can change under a runtime upgrade would
quietly change which tests a brief names. The one non-obvious rule is
that `**/` must also match *no* directory, or `**/*.test.ts` misses a
test file in the project root.

## `line` numbers count the header

`parseTestMap` records each entry's real line in the file, header
comments included, because a broken-mapping report names the line the
Client has to open. A test asserting `line: 1` for the first entry of a
*written* file is wrong — and was, first time around.

## What was deliberately left out

- **No staleness check.** Client ruling: a new source file with no
  mapping, and a mapping whose test file has gone, are surfaced on every
  delivery instead. The only assertion about this repository's own
  committed file is that it parses.
- **No folder-wide fallback in the generator.** 90 of this project's
  source files have no colocated test of their own and are left unmapped,
  which is the honest answer and makes the unmapped report a signal. Each
  test file *does* get a line mapping it to itself — not redundant: under
  the colocated convention nearly every task edits a test file, and
  without that line almost every delivery would report one as unmapped.
- **The live view's review page.** It renders the write-up through
  `finalMessageFor`, not the delivery's own fields, so `delivery.tests`
  shows up in `delivery.md`, on the `"delivered"` event and on the
  `fabrica status` row, but not yet on the review page.
