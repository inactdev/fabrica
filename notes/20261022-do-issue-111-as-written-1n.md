# Issue #111: saying which mode checked a task

## Where "which mode checked this" is read from, and why not the delivery

`fabrica status`/`fabrica log` now name the judging mode
(`src/cli/render.ts`'s `checkModeFromEvents`/`describeCheckMode`), read
from the task's own events: `inspector-called`/`inspection-finished` for
Inspector, `inspection-skipped` plus the worker box's `check-run` events
for the self-tested path.

The obvious alternative - reading it off the delivery, the way
`integrations/live-view/record-view.ts`'s `inspectorStampLabel` does from
`Delivery.inspection`/`Delivery.outcome` - was rejected for two concrete
reasons worth keeping:

1. `fabrica log` has to render the mode at the `inspection-skipped` event
   itself, which `judge.ts`'s `prepareRound` appends **before any work
   starts**. There is no delivery at that point in the history at all.
2. `Delivery` carries nothing that separates "self-tested and the check
   really ran" from "self-tested and nothing ever ran" (a round that went
   red on its own write-up never calls the judge, so no `check-run`
   lands). The Client's ruling on issue #111 requires those to read
   differently ("not checked - nothing ran" vs. "self-tested, not
   independently checked"), and only the event stream can tell them
   apart.

So the two surfaces disagree by design: the live view's stamp answers
"what did Inspector say", this answers "who did the checking".

## "Self-tested" means a check actually ran, including the not-verified case

The Client's clarification defined the third state as "no `check-run`
events at all", but a self-tested round whose **box could not run the
check** does append one (`selfTestJudge` records a `check-run` with
`notVerified`, right after that attempt's own `"started"` one) and is
delivered as `not-verified` - which `deliveredState` maps to
**"delivered"**, so it gets a mode line. Reading it as "self-tested"
would claim a check that never ran, against the same ruling's own stated
principle. So the reader looks at the latest `check-run`'s shape, not at
whether any exists: a `notVerified` one means not-checked, a `"started"`
or a green/red result means a check really ran. Why it could not run
stays where it already was - that event's own `fabrica log` line and the
delivery.

## The latest round wins, and the one case the record cannot answer

Mode is a per-round decision (`chooseCheckMode`), so a `fix` round can be
judged differently from the round before it - Inspector installed in
between, `.inspector.json` added. The reader is therefore latest-wins
(same rule as `projectFromEvents`/`prUrlFromEvents`), and `check-run` is
reset by each `inspection-skipped` so "nothing ran" is read per round.

The gap, documented on the function: an Inspector-mode round that never
reaches its judge at all (invalid write-up, rebase conflict, meter pause)
appends nothing of its own, so a task Inspector checked in an earlier
round still reads "inspector". Nothing on the record distinguishes that
from the mode simply not having changed. A per-round reset keyed on
`line-cut` would turn those rounds into "check mode unknown" for tasks
Inspector genuinely did check, which is the worse of the two readings.

## Sharp edge, unrelated to this change: grep finds nothing in
`integrations/live-view/record-view.ts`

That file contains one **literal NUL byte** - a deliberate cache-key
separator written as a raw byte inside a template string, around line 757
(``const key = `${project ?? ""}\0${branch ?? ""}` `` in
`baseStandingReader`). One NUL makes the whole file "binary" to grep, and
the grep on this fleet's boxes (ugrep 7.5.0) then prints **nothing and
exits 1** - indistinguishable from "that symbol is not in this file",
with no "binary file matches" notice at all. `grep -a` finds it; so do
`sed`, `node` and the editor tools.

Worth knowing before concluding a symbol has been deleted: everything
else about the file is ordinary TypeScript, and the project's own
source-scanning tests (e.g. `contract/rule8.no-favorite-brain.test.ts`)
read files through Node, so they are unaffected.
