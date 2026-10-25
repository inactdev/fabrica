# The code reader: a flagger between Inspector's green and the delivery

Inspector issue #34 and its amendment. Written down before the change,
as the standing instruction asks, then kept as the durable record of
what was decided and why.

## The design, and the one alternative rejected

The reader is **not a machine**: it has no make, no workstation, no
ProductionLine and no box. It is one direct model call Fabrica makes
itself, from the host, over the common chat-completions request shape -
which is why `[reader]` carries `vendor` and `model` only, exactly like
`[reviewer]`, and why `src/reader/` sits beside `src/reviewer/` rather
than under `src/brain/adapters/`.

Where it runs: between `runAttempts` resolving green and
`recordRoundResult` writing the delivery - the one shared tail issue
#182 established, reached by `do.ts`'s round and `verdict.ts`'s fix
round alike. That placement is what makes "once per task, on the first
pass Inspector turns green" expressible at all: a task whose first
round goes red turns green for the first time in a *fix* round, and
both callers reach the same seam.

**The alternative rejected: run the reader inside `attempts.ts`, as
part of the judge.** It is a smaller diff - the judge already has the
green verdict in hand, and a correction brief already exists there for
a red check. It was rejected on two counts, either of which is fatal:

1. A findings pass run from inside the attempt loop **spends rule 3's
   counted attempt budget**. A fix round deliberately draws from no
   budget (issue #65, "separate the two, unlimited but counted"), and
   the reader's own pass is a fix round, not an attempt at the task.
   A task whose three attempts were already used would silently never
   get read.
2. The judge runs **per attempt**, so the reader would read every green
   attempt of every round. The ruling is once per task.

A third option - deliver first, then auto-issue a `fabrica verdict fix`
- reuses the whole fix machinery for free, and was rejected because the
amendment says the findings go back *before* delivery. A delivery the
Client sees and then watches reopen itself is a different, worse thing.

## The seven rulings this implements

1. `[reader]` carries `vendor` and `model`, globally and per project,
   overriding outright like `[reviewer]` does. **Absent is a refusal**
   at task start, naming the exact lines to add - never a silent
   fallback to `[reviewer]`, and never a built-in default.

   Where that refusal lives took a correction partway through, and the
   reasoning is worth keeping. The obvious place was `prepareRound`,
   beside `requireReviewer`, throwing `ForemanError`. That was built,
   and then undone: `prepareRound` runs before the round's first worker,
   but a `[reader]` the Client removed mid-task, or any library caller
   that never went through the CLI, would then have a **finished, green
   delivery destroyed over a configuration problem** - worse than the
   thing the ruling protects against, and flatly against the
   amendment's own answer that the reader never blocks. So `fabrica do`
   refuses (it *is* task start, it costs nothing, and it is where the
   paste-these-lines message belongs), `reader.ts`'s `readerForRound`
   returns a problem instead of throwing, and the round records
   `reader-failed` at the moment the read fell due. There is
   deliberately no `reader-not-ready` error code to match
   `reviewer-not-ready`.
2. **Once per task**, on the first pass Inspector turns green. The
   post-fix pass delivers straight after Inspector's green with no
   second read, so at most one reader fix round exists. A recorded
   reader *failure* also counts as the read having happened - otherwise
   every later fix round would retry it, which is the repeat the ruling
   forbids.
3. Every finding goes to the worker **as-is**. There is no severity
   split and nothing is filtered: the machine may decline any finding
   with a written reason, and that reason is recorded beside the
   finding in the delivery.
4. The reader **never blocks and never approves**. A reader stage that
   fails - unreachable model, unreadable answer, a diff too large to
   send - lands on the record as `reader-failed` with the error, shows
   on the status row, rides on the delivery, and is counted on
   `fabrica status`'s bottom line. The delivery proceeds either way.
   This is the one place where "it never blocks" wins over "everything
   fails loudly": it is never silent, which is what that ruling
   actually protects.
5. No findings means no fix round. The delivery proceeds and the record
   says `reader-clean`.
6. The findings and the model used are on the record and in the
   delivery.
7. The reader is scoped to Inspector mode. "After Inspector's green" is
   the trigger, and a self-tested task (no `.inspector.json` at its
   base commit) never has one.

## Sharp edges worth knowing before touching this

- **Rule 8's scan covers `src/reader/` including its README.** The scan
  (`contract/rule8.no-favorite-brain.test.ts`) reads *every file* under
  `src/` outside `adapters/`, so no vendor, model or harness name may
  appear here - not in prose, and not in an import specifier. That is
  why the request shape is written out fresh in `src/reader/call.ts`
  instead of importing the direct-API adapter's own client: the
  specifier alone would fail the scan. It is also why `<VENDOR>_BASE_URL`
  is **required** for a reader rather than optional the way it is for a
  reviewer - Fabrica dials the endpoint itself here, and it holds no
  vendor-to-endpoint table and has no business holding one.
- **The worker answers the findings through a file in its own workdir,
  not through the write-up.** `BrainWorkResult` has no free-form
  structured channel (`writeup` is a fixed schema for pull request
  bodies), and widening a ratified contract shape for this would be the
  wrong trade - the same reasoning, and the same mechanism, as
  `src/quiz/recheck.ts`'s `quiz-recheck.json`. The difference here is
  that this worktree *is* committed, so the file must not survive into
  the diff: it is read and deleted in `attempts.ts`'s existing
  `beforeCommit` hook, which runs immediately before the commit.
- **A reader fix pass whose worker changes nothing must not discard the
  already-green round.** Wrapped with `skipIfUnchanged` it would
  deliver `nothing-changed` and throw away a green delivery; unwrapped
  it would re-hand an identical commit to Inspector and draw a refusal.
  So `reader-round.ts` wraps the judge, and on `unchanged` keeps the
  original green judgement while still carrying the pass's receipt, so
  the money is counted and the green stands.
- **A reader fix pass is a real pass**, so its own Inspector result is
  the round's result: a pass that goes red delivers `inspection-red`
  for the Client to rule on. The reader not blocking is about the
  *reader stage*, not about a worker pass that then fails its check.
- The diff is sent whole. A diff past `MAX_DIFF_BYTES` is a
  `reader-failed` naming both numbers rather than a truncated read
  presented as a read.
- **Every `reader-failed` message is folded to one line.** It becomes a
  `fabrica status` row, a `fabrica log` entry and a `delivery.md` field,
  and a provider's multi-line error body otherwise breaks all three into
  fragments that read as separate facts. This was found the hard way:
  the unconfigured-reader case first recorded `fabrica do`'s whole
  paste-these-lines message, and `fabrica log`'s own event-sequence test
  started reporting `'[reader]'` and `'vendor'` as event names.

## One behaviour change worth knowing about

`fabrica do` against a literal `--project` path used to work with no
`projects.toml` in the record home at all. It does not any more, because
`[reader]` lives in that file and every task is read. The refusal names
the lines to add. A literal path still needs no `[projects.<name>]`
*entry* - which is what that property was really protecting - only a
`[reader]`. `src/cli/do-command.test.ts` carries both halves of this as
tests, and the old one's name and comment say what changed.

## Three places that resolve "which projects.toml entry is this path"

`src/reviewer/resolve.ts`'s `reviewerFor`, `src/reader/resolve.ts`'s
`readerFor` (added here), and `src/foreman/registered-project.ts`'s
`registeredProject` all do the same realpath-on-both-sides lookup, and
all three are still standing. Not unified on purpose: `registeredProject`
swallows a malformed registry (by design - `resolve-check.ts` reports
that loudly first), while the other two take an already-loaded config so
one `fabrica do` run resolves the file once. A single helper would have
to take a side on that. Named here so the duplication is known rather
than missed.

## Rebasing the reader onto master's fingerprint + GitHub App work

Two merged changes landed in the same places this one touches, so the
rebase conflicted in fifteen files. Both sides are kept everywhere; the
only decision worth writing down is the *order* the two wrappers go in
on a delivery, because it recurs five times in `round.ts`:

    withRead(withTests({ ...buildXDelivery({ ... }), ...stamp() }), ctx.reader)

`withTests` and `stamp()` are inside, `withRead` outside. Neither reads
the other's field, so the order is free - but `withTests`' report is
derived from the delivery's own `files`, so it must see a delivery the
builder has finished with, while `withRead` is explicitly documented as
attaching to "a delivery the builders above have finished with". Putting
the derived-from-the-delivery wrapper innermost and the purely-attached
one outermost is the shape that stays readable when a third arrives.

The alternative considered was giving each builder a `reader` parameter
alongside the fingerprint fields, which is what the fingerprint work
chose for `stamp()`. Rejected: `delivery.ts` already says why in
`withRead`'s own comment - a flagger never moves an outcome, a
confidence or a summary, so a builder taking it as an argument would
imply a say it deliberately does not have.

The other repeated shape is the option bag: `minter?: TokenMinter` and
`readDiff?: DiffReader` are both new test seams threaded through
`createForeman` -> `do`/`answer`/`verdict`, so every signature and every
call site in `foreman.ts`, `answer.ts`, `do.ts` and `verdict.ts` wanted
both names added side by side. There are now six of these seams
(`inspector`, `checkBox`, `checksReader`, `issueReader`, `minter`,
`readDiff`) passed one at a time rather than as one object; left as is,
but every new one means another five-file edit.

One conflict needed more than a union. `verdict.ts`'s fix round used to
build its worker brief inline, once, inside the rebase-pass loop; this
change factored that out as `briefFor(extra)` so the reader's own fix
pass could reuse it, and master's test-map change (issue #142) added a
third argument to the same `workerBrief` call - `{ testMap, touched:
diffFiles(line.project, line.branch, roundBaseCommit) }`. Keeping both
meant moving `briefFor`'s declaration down into the `try` block, after
`roundBaseCommit` exists: it was declared beside the round's other
derived values, which are all known before the rebase is attempted, and
`roundBaseCommit` is not. Reading the mutable `roundBaseCommit` from
inside the closure is deliberate and is what master's own comment asked
for - a rebase that stops and is continued moves the base mid-round, so
every pass's `touched` list has to be the one that pass is working
against, and the reader's fix pass gets the same treatment for free.

The alternative was a `touched` parameter on `briefFor`, computed at
each of the three call sites. Rejected: three call sites recomputing one
derived value is exactly the duplication `briefFor` was extracted to
remove, and a pass that forgot it would silently send a worker a brief
with no test map rather than failing.
