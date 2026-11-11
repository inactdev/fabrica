# A cancelled CI run is not a result (issue #348)

Durable facts this task established, for whoever next touches `src/ci/`.

## `filter=latest` does not collapse two runs of the same check name

`src/ci/read.ts` asks the check-runs endpoint with `filter=latest`, and
the old comment there claimed that was enough to read "a re-run of a job
as its newest attempt, not as two checks of the same name disagreeing".
It is not. GitHub documents `filter` as nothing more than *"Filters check
runs by their completed_at timestamp. latest returns the most recent
check runs"* (REST reference, Checks → List check runs for a Git
reference, read 2026-11-11) — it says nothing about collapsing per
**name**, and issue #348 is the empirical proof that it does not: one
commit carried two `cancelled` runs of a check *and* a later `success`
run of the same check, and all of them reached Fabrica. Each workflow run
opens its own check suite, which is the level `latest` appears to work
at.

So the per-name reduction has to be ours. It is `src/ci/latest.ts`, and
it is not optional cleanup: without it, any repository whose workflows
use `concurrency: cancel-in-progress` with an `edited`/`synchronize`
trigger will hand Fabrica an obsolete answer for a check that has since
passed on the same commit.

## Ordering two runs of one check

The fields available for "which run is newest" are `started_at` (a
documented, nullable date-time), `completed_at` (null while a run is in
flight, so useless for the case that matters) and `id` (int64, newer in
practice but documented nowhere as monotonic). `latest.ts` therefore
orders on `started_at`, breaks a tie on the larger `id`, and breaks a
remaining tie by preferring a run that has answered and then a red
answer over a green one — so a tie can never silently resolve into a
pass, and the result never depends on the order GitHub happened to list
them in.

## Why cancelled became "unresolved" rather than a third category

`ChecksReport` already had exactly the right bucket for "no answer from
this check": `unresolved`, which keeps `poll.ts` waiting and, when the
wait expires, yields verdict `unknown` — which nothing downstream turns
into a red or a retry. Mapping a cancelled-only check into it got all
three of the issue's asks with no new verdict, no new event name and no
new field on the report.

The alternative considered and rejected: a fourth `ChecksVerdict`
(`"cancelled"`) plus a `cancelled: CancelledCheck[]` list on the report.
It would have been more literal, but every surface that renders a report
(`src/cli/ci-checks-render.ts`, the live view, `report.ts`,
`ci-checks.ts`'s two event shapes) would have needed a new case for a
state that means precisely what `unknown` already means — "nobody
answered, so neither green nor red" — and a reader who missed one of
those cases would have had a state that renders as nothing at all. More
surface, more ways to get it wrong, same behaviour.

## The retry setting is read where it is used, not filled in by the loader

`retryOnRedChecks` is optional on `ProjectConfig` and defaults to `true`
at its one read site (`src/foreman/ci-checks.ts`'s
`retryOnRedChecksFor`), the shape `noStamp` has — deliberately **not**
`onlyTouchedTests`'s shape, where the loader fills a non-optional field
in. Both make an existing `projects.toml` carry the default, but the
non-optional version would have changed the object every
`deepEqual`-against-a-whole-`ProjectConfig` test in `src/config/` compares
against, for no behavioural difference.

## It stops the retry, it does not shorten an explicit count

`retryOnRedChecks = false` ends the round on a red check *when a red is
the only thing that would have caused another attempt* — i.e. under the
default policy (`stopEarlyOnGreen: true`). A task started with an
explicit `--attempts N` runs all N either way, green or red, so the red
is not what caused the extra attempt and there is nothing for this
setting to prevent; cutting that count short would also break CONTRACT
rule 3 ("when the Client gives a count, exactly that many worker
invocations happen") for no gain.
