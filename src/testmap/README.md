# src/testmap — a project's committed test map

`tests.map`, in a project's root: which tests cover which files. When a
project commits one, every task's brief tells its worker to run the tests
its touched files map to before anything else, and every delivery records
what came of that.

Fabrica never runs any of these tests. It names them; the worker runs
them in its own box, and the project's own check runs the whole suite
afterwards. Running a project's tests on the host is what issue #64
settled against, and `src/foreman/no-host-check.test.ts` fails if
anything under `src/foreman` spawns anything but `git`.

## The format

Plain text, one entry per line: a glob pattern, a colon, then
comma-separated test files or commands. Blank lines and lines whose first
non-space character is `#` are comments.

```
src/foreman/do.ts: src/foreman/do.test.ts
src/cli/*.ts: npm test -- src/cli
```

Deliberately not TOML/YAML/JSON, even though this project already
depends on a TOML parser for `projects.toml`: this file is meant to be
read and hand-edited in a diff, one line per mapping, with nothing
nested to get wrong.

Only the **first** colon separates a pattern from its tests, so a command
carrying one of its own survives (`npm test -- --reporter=spec:verbose`).

`glob.ts` owns the wildcard rules and is written out rather than taken
from a dependency or from Node's own still-experimental
`path.matchesGlob`: a matcher whose semantics can change under a runtime
upgrade would quietly change which tests a brief names.

| | |
|---|---|
| `*` | any run of characters **within** one path segment |
| `?` | exactly one character within one path segment |
| `**` | any run of characters, crossing `/` freely |
| `**/` | as `**`, and also matches no directory at all |

Everything else is literal, `.` included.

## The three rulings this module implements

Each of these was decided by the Client directly, and each is the
opposite of what a reasonable person might otherwise build:

**Union, not most-specific-wins.** A touched file takes the tests of
*every* entry it matches. Adding a line can therefore only ever add
tests to a run, never silently take one away by shadowing a broader
entry.

**Unmapped is reported, not fatal.** A touched file no entry matches is
named on the delivery and on the `fabrica status` row. The whole suite
still runs, so nothing actually goes unchecked - what is missing is a
fast, targeted test for that file, and saying so out loud is the
loudness the standing ruling ("a silent skip is a bug") asks for here.
It never fails the pass.

**A broken mapping is reported, not fatal.** A mapping naming a test
*file* the project does not have is reported the same way, with the line
number to edit. Only path-shaped targets are checked (`match.ts`'s
`looksLikePath`): there is no honest way to tell whether `npm test --
foo` is stale without running it, which this side never does, so a
command is never called broken. The delivery's own wording says that
limit rather than implying the list is complete.

## What is NOT here

**No staleness check.** Nothing fails because a new source file has no
mapping, or because a mapping has gone stale - the Client ruled that
both are surfaced on every delivery's own report instead. The one thing
`load.test.ts` does assert about this repository's own committed file is
that it *parses*: a hand edit that breaks the format would otherwise
fail every task on this project, one task at a time, rather than here
once.

**No verification of the worker's report.** `TestMapReport.
reportedByWorker` is the worker's own words about which mapped tests it
ran, carried verbatim and never compared against the mapped list -
"the record is the worker's own report and is marked as such; Inspector's
full-suite run is the independent check and is not asked to verify the
list". Comparing them would invent a verdict Fabrica has no evidence
for: the tests ran in the worker's box, and the whole suite runs
afterwards either way.

**No folder-wide fallback in the generator.** `generateTestMap` reads
one convention - `foo.ts` beside `foo.test.ts` - and leaves a source file
with no colocated test of its own unmapped. That is the honest answer:
the map says what the convention knows, the delivery then names the gap,
and the file is hand-editable for the cases where a human knows what
actually covers one. Each test file does get a line mapping it to
itself, which is not redundant - under this convention nearly every task
edits a test file too, and without it the unmapped report would be noise
on almost every delivery.

## Where it is wired in

| | |
|---|---|
| read, per round | `src/foreman/test-map.ts` — before the ProductionLine is cut, so an unreadable file fails the task with nothing to tear down (`ForemanError("test-map-unreadable")`) |
| the brief | `src/foreman/touched-tests.ts` — and it **replaces** `ONLY_TOUCHED_TESTS_NOTICE` rather than joining it, since that notice tells a worker not to run the whole suite and this one tells it to |
| the worker's report | `WorkerWriteup.testsRun` (optional, widened in `src/brain/types.ts`) |
| the delivery | `src/foreman/round.ts`'s `withTests`, resolved against the very `files` diff the delivery itself reports |
| the status row | `src/cli/render.ts`'s `testMapNoteFromEvents` |
| generating one | `fabrica tests-map` (`src/cli/tests-map-command.ts`) |

Nothing here appears in `contract/surface.ts`. `Delivery.tests` is
widened in `src/inspector/types.ts` and `WorkerWriteup.testsRun` in
`src/brain/types.ts`, for the same reason `Receipt.meters` and
`stopped-by-owner` are: the contract is a path `rule9-gate.yml`
protects, and a project's own bookkeeping about its own test suite is not
a new promise about a seam.
