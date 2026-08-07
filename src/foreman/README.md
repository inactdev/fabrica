# The Foreman

`src/foreman/` is the real implementation behind `createForeman` in
`src/index.ts` (issue #7, "the loop: `fabrica do`"; issue #45 moved the
public entry point here from `contract/`). It is the delegator LANGUAGE.md
calls the Foreman: it registers a task, cuts a ProductionLine, runs a
Worker for a counted number of attempts, verifies the result with the
project's own check, and writes a delivery — wiring `src/record`,
`src/line`, `src/brain`, and `src/config` into the one loop SPEC.md calls
"fabrica do". It is pure code: it delegates and counts, it never decides
anything a model should decide instead.

## `createForeman({ recordHome, caps?, brain? })`

```ts
const foreman = createForeman({ recordHome: "/Users/ari/.fabrica" });
```

- **`recordHome`** — where the record lives (`src/record/README.md`). Every
  task this Foreman touches reads and writes under here; nothing in this
  module ever falls back to a fixed default path.
- **`caps`** — `{ perTaskUsd?, perDayUsd? }`. Accepted so this factory's
  shape matches `contract/surface.ts`'s `Foreman` exactly. Not
  enforced here: CONTRACT rule 10 ("It cannot outspend you") is issue
  #11's job, not this loop's. Passing it today has no effect; omitting it
  has no effect either.
- **`brain`** — only used by `verdict()`'s "fix" path, as a fallback for
  when this instance never saw a `do()` call for that task. See
  "`verdict(taskId, ruling, note?)`" below for why `verdict()` itself has
  no brain parameter of its own.

The return value satisfies `Foreman` (`contract/surface.ts`): `do`,
`deliveryOf`, `receiptsOf`, `verdict`, `status`, `events`, `recordPath`.

## `do(taskText, { project, attempts?, brain? })`

One call runs the whole loop to completion — register, cut, work, check,
possibly retry, deliver, tear down — and only then resolves. That is a
deliberate simplification, not an oversight: see "Why `do()` doesn't
return early" below.

1. **Registers** the task via `src/record`'s `registerTask`: a new
   `taskId`, `request.md` written verbatim, a `task-received` event.
   `brief.md` is written too, identical to the request — v1 never asks a
   clarifying question (see "The ask-first seam" below), so there are no
   answers yet to fold in.
2. **Cuts a ProductionLine** via `src/line`'s `createProductionLine`,
   passing `project` straight through as a filesystem path — the root of
   the Client's own git checkout. The Client's checkout is never written
   to (CONTRACT rule 1); everything from here on happens in the
   ProductionLine's `workdir`.
3. **Resolves the check command** (`resolve-check.ts`) and refuses before
   any Worker runs if there isn't one (`check.ts`'s `requireCheckCommand`)
   — CONTRACT rule 2 allows no path around the gate, so a task with
   nothing to verify against is refused up front, not after burning a
   Worker call on it.
4. **Runs the attempt loop** (`attempts.ts`): calls `brain.work(...)`,
   then runs the check, for up to `attempts` rounds. See "How `attempts`
   actually behaves" below — it is not simply "retry until green."
5. **Checks for an undeclared gate change** (`gate-changes.ts`) — CONTRACT
   rule 9. If the check script changed and nothing declared it, the
   outcome is forced to `discarded-protected-path` regardless of whether
   the check went green - recorded honestly, not thrown away (see "Rule
   9: blocked by CI, not by Fabrica's own mark" below).
6. **Commits, builds, and validates the delivery**: any changes still
   sitting uncommitted in the worktree are committed onto the
   ProductionLine's branch (`commit.ts`) before that worktree is
   destroyed - see `src/delivery/README.md`'s "files-list-vs-teardown
   decision" for why. This runs for every outcome uniformly, including
   `discarded-protected-path` - a rule 9 violation is no longer force-
   reset or thrown away (Client ruling, superseding the original
   design): the work stays committed on the ordinary `fabrica/<taskId>`
   branch, exactly like any other outcome. Fabrica does not mark the
   branch, rename it, or otherwise flag it for CI - see "Rule 9: blocked
   by CI, not by Fabrica's own mark" below for why that mark was tried
   and then deliberately removed.
   `delivery.ts` builds the `Delivery` object from the branch's own diff
   (pinned to the commit the line was cut from, via `src/delivery`'s
   `baseCommitOf`), and `src/delivery`'s `validateDelivery` (CONTRACT
   rule 4, issue #9) proves it's complete before anything downstream sees
   it - structural only (required fields, right types); it does not
   separately re-check `files` against the diff, because `files` is
   already read straight from that diff above, not a claim to weigh
   against it (see `src/delivery/README.md`'s "Why there's no check
   against the branch's real diff"). `delivery.md` is written for a human
   to read; the same structured `Delivery` object lands on the
   `"delivered"` event for `deliveryOf` to read back exactly.

   If the commit itself fails (`ForemanError("commit-failed")` - a stale
   `.git/index.lock`, a full disk, a read-only mount) this step diverges:
   `finally` below still force-removes the worktree, so there is no
   branch content or check outcome left to describe the usual way. Client
   ruling (PR #54 follow-up) - a task must never vanish from the record
   without a trace, even when the host environment is what failed, not
   the Worker or the project's checks. `delivery.ts`'s
   `buildCommitFailureDelivery` builds a `failure-report` naming the git
   error instead, `doTask` still writes `delivery.md` and appends
   `"delivered"`, and returns early - scoped minimally, no retry
   machinery, just an honest record of what happened.
7. **Destroys the ProductionLine** in every case — success, failure, or a
   thrown error — via a single `finally`.

### `project`

Always a filesystem path to the root of a git repository — the same
thing `createProductionLine` expects. SPEC.md's CLI describes `--project
<path-or-name>`; the "or-name" half (looking a registered project up by
name in `projects.toml`) is a CLI-layer concern - `src/cli/resolve-project.ts`
(issue #47) does it before this function is ever called -
not something this function does. `resolve-check.ts` does something
related but different: it looks a *path* up in `projects.toml` to find
that project's configured check command (see below) — it never treats
`project` itself as anything but a path.

### `attempts`

Example: `foreman.do("fix the flaky test", { project, attempts: 3, brain })`.

Omit it and the default is 2 — SPEC.md's step 5: one attempt, and on red
one fix pass with the failure output, then re-check. Still red after
that is a failure report, never "done" (CONTRACT rule 2).

Give an explicit number and the loop runs *exactly* that many attempts,
full stop — even if an earlier attempt's check already went green. That
is CONTRACT rule 3, "three means three," taken literally: a number given
is a number honored, not a ceiling the code is free to cut short because
it decided the work already looked done. `rule3.n-means-n.test.ts` proves
this with a project whose check is *always* green, specifically to rule
out "it just happened to need that many tries" as an explanation.

So there are two policies, chosen by one thing — whether the caller gave
a number:

| `attempts` | Stops early on green? | Why |
| --- | --- | --- |
| omitted (default 2) | yes | SPEC.md's real, cost-conscious default: don't burn a second Worker call on a task that already passed. |
| given explicitly | no | CONTRACT rule 3: an explicit count is a promise, not a hint. |

An explicit `attempts` that isn't a positive integer is refused up front
(`ForemanError("invalid-attempts")`), before any task is registered or
line cut.

### `brain`

Required here, with no fallback: omitting it raises
`ForemanError("no-brain")` before anything else happens. A real adapter
does exist now (`defaultBrainAdapter()`), but choosing it is the caller's
job - `src/cli/run-task-entry.ts` passes it for `fabrica do`. Only
`verdict()`'s fix path falls back on its own, because
`contract/surface.ts`'s `Foreman.verdict` has no brain parameter to pass
one through (see "`verdict(taskId, ruling, note?)`" below).

## Why `check.sh`, not only config

CONTRACT rule 2 needs *a* check command for every task, but every
contract test hands `do()` a bare filesystem path with no `projects.toml`
anywhere — there is no name to look up. `resolve-check.ts` resolves this
with one rule: if `projects.toml` at `recordHome` registers a project
whose `path` matches this ProductionLine's project (after both sides are
resolved through `realpath` — see the sharp-edge note in that file's
comment, and in the project's own root agent-memory file), that
project's configured `check` command wins. Otherwise it falls back to the v1 default convention: an
executable `check.sh` at the project's root, run as `./check.sh -> exit
N`.

```toml
# recordHome/projects.toml
[projects.spending-app]
path  = "/Users/ari/inkling-umbrella/spending-app"
check = "bin/ci"
```

A task run against that exact path gets `bin/ci` as its check command; a
task run against any other path (every contract test's throwaway fixture
repos, or an ad hoc path before it's ever registered) gets the
`check.sh` convention. Nothing about how `do()` runs changes between the
two — only which command `runCheck` executes.

## What CONTRACT rule 9 protects, and what it doesn't yet

`gate-changes.ts` asks git, after the attempt loop, whether `check.sh` in
the workdir differs from its content at the task's pinned `baseCommit`.
Differ with no `gateChanges` declared, and the outcome is forced to
`"discarded-protected-path"` — overriding even a green check, exactly as
CONTRACT rule 9 requires ("no matter how good the result looks").

The baseline is the *pinned base commit*, never the file the round found
in the workdir when it started. A rule 6 "fix" round reopens a worktree
on `fabrica/<taskId>`, which already carries whatever the previous round
committed, so a round-local snapshot would make round 1's tampered gate
round 2's idea of "pristine": the tamper would read as clean, and a
worker honestly putting `check.sh` back would be accused of changing it.
The same reason is why `verdict.ts` carries the previous round's
`gateChanges` declaration forward (`mergeGateDeclarations`) — the
comparison is cumulative since `baseCommit`, so the declaration covering
a change still on the branch has to be cumulative too, or a round that
merely leaves a legitimately declared change alone would be flagged for
it. Because the whole comparison rests on that commit being readable,
`requireGateBaseline` proves it is before any Worker runs, rather than
discovering it after an attempt has been spent.

**Known v1 limitation:** this protection only applies when the check
command in use is the `check.sh` convention above. A project registered
with a custom `check` command (`bin/ci`, `npm test`, …) has no single
file this module knows to watch, so an undeclared change to *that*
project's real checks isn't caught yet. This is a real, documented gap,
not a silent one — closing it needs a way for a registered project to
say which paths are its "ratified tests and check settings," which
doesn't exist yet.

## Rule 9: blocked by CI, not by Fabrica's own mark

Two earlier designs here, both superseded by Client rulings. First, an
undeclared gate change force-reset the branch back to its fork point and
saved the discarded work as a patch in the record (`discarded.patch`),
so nothing tampered ever reached a mergeable branch — overturned because
"keeping something mergeable around is fine as long as it doesn't get
merged," and the Client is the one person who can tell a declaration
mistake from actual cheating, so he should get to look at the real work
and decide, not read a patch file reconstructed from it. Second, the
branch was left mergeable but renamed from `fabrica/<taskId>` to
`fabrica/discarded/<taskId>`, so a CI workflow could find and block it by
name — overturned in turn, for a sharper reason: that design still had
Fabrica marking its own violation, and CI trusting the mark. A bug in
`gate-changes.ts`, or a Worker clever enough to evade its detection,
would mean the rename never happens, and CI sees an ordinary branch name
and waves it through. The thing being policed was writing its own
accusation.

So today a `discarded-protected-path` outcome behaves exactly like every
other outcome, full stop: whatever a Worker left in the worktree,
committed or not, ends up on the ordinary `fabrica/<taskId>` branch, and
Fabrica does nothing further to flag it. Detection stays exactly where
it was — `gate-changes.ts` still forces this outcome, honestly, no
matter how good the check looked, and it still lands in the delivery and
the receipt (rule 5's total-recall concern, separate from enforcement).
What changed is that detection no longer drives enforcement at all.

**Enforcement lives outside Fabrica, in `.github/workflows/
rule9-gate.yml`.** It queries the GitHub API for the pull request's
changed-file list - never a checkout, never `git diff` - for whether it
touches a protected path (`check.sh` today, the same file
`gate-changes.ts` watches, plus `.github/workflows/**` itself; the list
is one `PROTECTED_PATHS` value in the workflow file, easy to extend for
a project with a different check convention). This needs nothing from
Fabrica: not `delivery.outcome`, not a branch name, not any record file.
It works identically for a human contributor's PR and for a Worker's,
and a bug or an evasion in Fabrica's own detection can't also blind the
thing meant to catch it. It deliberately blocks a *declared* gate change
too, not only an undeclared one — a change to the thing that decides
whether work passes deserves the Client's eyes every time; Fabrica's own
delivery record still tells the two apart for the Client's benefit
(`gateChanges`), the CI check does not need to.

**Protecting its own definition.** An earlier version of this workflow
ran on plain `pull_request`, which has a sharp edge review caught twice:
GitHub reads a `pull_request` workflow's *definition* from the PR's own
head, so a PR could edit `check.sh` and rewrite `rule9-gate.yml` in the
same commit, and the rewritten (neutered) gate is what actually ran -
the thing being policed supplying its own enforcement code, the exact
failure mode branch-renaming was overturned for one design earlier.
Client ruling: the trigger is `pull_request_target` instead, which reads
the workflow's definition from the base branch (`master`) regardless of
what the PR contains, and `.github/workflows/**` is itself in
`PROTECTED_PATHS`, so an edit to this file is exactly the kind of change
that now blocks the merge. `pull_request_target` is dangerous in general
- it runs with the base branch's elevated permissions and secret access,
and the standard disaster is a workflow that then checks out and
executes the PR's own code with that access. This job never does: it
only asks the API which files changed and compares names, no
`actions/checkout`, no execution of anything from the branch, ever - see
the workflow file's own header comment, which says so loudly on purpose
for whoever edits this file next. The changed-file listing also has to
account for renames the same way the earlier git-diff version needed
`--no-renames` for: the API reports a pure rename as one entry (the new
filename plus `previous_filename`), so the step checks both, or a PR
renaming `check.sh` away would evade detection exactly like the
git-rename case did. That listing is also capped at 3000 files by
GitHub, however many pages are requested, and the truncation is silent -
the dropped entries just never arrive, nothing matches, and the gate
would report a pass on exactly the change it exists to block. So the
step counts the entries it got and fails the job unless that count
equals the pull request's own `changed_files`: an unreadable file list
blocks the merge rather than waving it through, the same way an API
error already did. That mismatch has a second, unrelated cause worth
knowing about: `changed_files` is a snapshot from the event payload
while the listing is fetched live, so a push landing mid-run makes the
two disagree with nothing truncated. Both cases fail closed - the step
only tells them apart to word the error honestly, since the API returns
exactly 3000 entries when it truncates and never fewer, so exactly 3000
listed against a larger `changed_files` is the cap and anything else is
the race. Nothing here tries to eliminate the race: GitHub reruns the
check on every new push, so a later run corrects it on its own.

**The check itself:** the job runs on every pull request, unconditionally
- the path match happens inside the one step, not as a job-level `if`,
because a skipped job reports a "skipped" conclusion and whether GitHub
treats that as passing a *required* status check is a known trap, not a
documented guarantee. So every run reports a real pass or fail: a PR
touching `check.sh` (or `.github/workflows/**`) fails on purpose, naming
the file and stating plainly that only the Client may review and
override; any other PR clears that check. The same job also runs a second,
separately-worded pass over the same file list for `contract/**` and
`CONTRACT.md` (`CONTRACT_PROTECTED_PATHS`, issue #53) - not a third rule
9 case, since changing the contract is allowed and only needs to never
merge itself; the workflow file's own header comment owns that reasoning,
and `contract/rule9-gate.contract-paths.test.ts` proves the pattern list
and its distinct wording are there. The job's `permissions:` are scoped to
`pull-requests: read` only, the minimum the API call needs, rather than
inheriting the default token scope. The job name stays
`block-protected-path-change` regardless of any other change to this
file - that exact string is what gets wired into the repository's
required-status-check settings, and a rename silently breaks the
protection. Branch protection is what makes a failing check actually
block a merge — that's a GitHub repository setting, not something this
code can turn on for you; see the workflow file's own header comment.

**A red check here is sometimes the correct outcome.** A PR that edits
the workflow, or (since issue #53) touches `contract/` or `CONTRACT.md`,
fails this check itself - by design, every time. GitHub runs the *base
branch's* copy of the workflow, so the branch's own version never
executes and nothing committed on the branch can turn that check green;
the only thing the running job reads from the PR is the list of
filenames it changed. Which leaves exactly one way to go green - change
fewer files - and taking it means deleting the very change the PR exists
to make. Don't. The Client reviews a protected-path change and merges it
by hand; that is the whole mechanism, not a gap in it.

**Known v1 limitations, two of them:** this workflow lives only in this
repository's own `.github/workflows/` — a project Fabrica manages
elsewhere currently has no gate at all. [Issue #55](https://github.com/inactdev/fabrica/issues/55)
tracks closing that; it is not solved here. And SPEC.md's `fabrica do`
never pushes anything to a remote on its own, so this check only ever
runs once something *else* pushes the branch or opens a PR from it —
today that means the Client, by hand.

## Why `do()` doesn't return early

SPEC.md describes `fabrica do` as detached: it prints the task id and
returns immediately while work continues in the background, streaming to
the transcript. This module's `do()` does not do that — it runs the
whole loop to completion before resolving.

That's deliberate, not a shortcut taken by accident: every contract test
calls `await foreman.do(...)` and immediately inspects `deliveryOf` and
`receiptsOf`, which only makes sense if the delivery already exists by
the time the promise resolves. "Detached" is a property of the CLI a
Client types at — spawning the loop in a background process and
returning control to the shell right away — not a property this
programmatic seam can have while staying testable synchronously.
`src/cli/` (issue #47) makes that distinction concrete: `fabrica do`
wraps this same `do()` in a detached child process without reshaping
anything here - `src/cli/README.md` owns the mechanism.

## The ask-first seam

SPEC.md step 2 says v1's default is to ask a clarifying question before
working on a materially ambiguous task. This module always proceeds
straight to work instead. Two things make that the honest choice for
now, not a corner cut:

- The `Brain` interface (`src/brain/README.md`) has no way for a Worker
  to hand back "I have questions" instead of doing work — only a
  transcript, an optional gate declaration, and an optional session id.
  There is nothing to route yet.
- `rule5.total-recall.test.ts`'s expected event order —
  `task-received`, `work-started`, `check-run`, `delivered` — has no
  `questions-asked` step in it. The loop as ratified today goes straight
  through.

`brief.md` is written on every task regardless — see the comment above
the `writeTaskFile` call in `do.ts` for the full reasoning, which is two
complementary halves. `fabrica answer` (issue #8) is why it's written
*now*, upfront: so a clarify round only has to append to `answers.md` and
re-derive `brief.md`, instead of creating the file itself. Per-project
lessons (issue #19) are why it must be *stored* rather than derived on
demand later: once lessons get primed into it, `brief.md` becomes the
record of what was actually handed to a Worker, not a cache of
`request.md` — material `request.md` + `answers.md` can no longer
reconstruct on their own, because lessons change over time. Today the two
files are byte-identical, because v1 does neither yet.

## Why receipts and deliveries live on `events.jsonl`, not their own file

`src/record`'s `TaskFile` union has no slot for a Delivery object or a
list of Receipts — only markdown/text files a person reads
(`delivery.md`, `transcript.log`, …). Rather than invent a place to store
structured data outside the record, `do()` puts the whole `Delivery`
object and the full `Receipt[]` array straight into the `"delivered"`
event's `details` field (alongside the `project`, `totalAttempts`, and
`baseCommit` a later fix round needs - `queries.ts`'s
`DeliveredDetails`). `deliveryOf` and `receiptsOf` (`queries.ts`) read
the *latest* `"delivered"` event back and return its `details.delivery` /
`details.receipts` directly — no markdown parsing, no second source of
truth. `delivery.md` still gets written, as a human-readable rendering of
the exact same object, matching the same "events.jsonl is authoritative;
everything else is a convenience view of it" design `src/record/README.md`
already documents for `brief.md`.

One consequence: the last attempt's `Receipt.outcome` can't be decided
until *after* the attempt loop and the rule-9 gate check both finish (an
attempt that looked "delivered" the moment its check went green can still
turn into `"discarded-protected-path"` a moment later). Since
`events.jsonl` is append-only, that receipt can't be corrected in place —
so `do()` computes every receipt's final `outcome` before it ever calls
`appendEvent`, and logs the whole batch once, on its `"delivered"` event,
already correct. A `fix` verdict's round does the same, appending its own
`"delivered"` event carrying the cumulative receipts.

## `verdict(taskId, ruling, note?)` — rule 6, "you get the last word"

A delivered task stays open (`status()` still lists it, as `"delivered"`
or `"failed"`) until this is called. Every ruling appends a
`"verdict-recorded"` event, unconditionally — that event, not any
side-channel state, is what `queries.ts`'s `deriveState` reads to decide
whether a task is `"closed"`.

- **`accept`** — the work is right. Closes the task.
- **`wrong`** — not what was wanted, and not worth correcting. Closes the
  task, same as `accept` — a real outcome the record shows plainly, not a
  failure folded into `"failed"`.
- **`fix`** — right direction, wrong details. Does **not** close the
  task. `note` is required (there is nothing to correct without it) and
  becomes a correction handed back to the *same warm worker on the same
  line*: `src/line/resume.ts`'s `reopenProductionLine` re-creates the
  worktree at the exact `<recordHome>/tasks/<taskId>/worktree` path a
  Brain's session was born in — session resume is scoped to that `cwd`
  (`src/brain/adapters/`'s own docs) — checked out onto the same
  `fabrica/<taskId>` branch, which already carries whatever the prior
  round committed. `runAttempts` (`attempts.ts`) is called with
  `initialSession` set to the last receipt's session id and
  `startAttempt` continuing the numbering, so the record shows one
  running attempt count across the whole task, not a count that resets
  per fix. A second `"delivered"` event is appended with the fix round's
  own outcome and the **cumulative** receipts (prior + this round) —
  `queries.ts`'s `deliveryOf`/`receiptsOf`/`deriveState` all read the
  *last* `"delivered"` event for exactly this reason, not the first.

  **What a fix costs, precisely**: nothing, on purpose (issue #65). Rule
  3's "three means three" bounds `do()`'s own retry loop — a *machine*
  trying, failing, and trying again unattended — not a correction the
  Client explicitly asked for; nothing happens until he rules `fix`, so
  he is the stop condition, not a counter. `verdict("fix", …)` has no
  ceiling and never refuses with `ForemanError("attempts-exhausted")` —
  that code and error stay in the codebase for what they were built for,
  `do()`'s own budget, and still fire there. `project`, `baseCommit`, and
  the *original* `totalAttempts` are still persisted on the `"delivered"`
  event's `details` (`queries.ts`'s `DeliveredDetails`) so a later fix
  round can still find what it needs to reopen the line, but nothing
  reads `totalAttempts` to refuse a fix any more. Each round is counted
  and reported instead: `queries.ts`'s `fixRoundOf` derives the count by
  reading how many `"verdict-recorded"` events with `ruling: "fix"` a
  task has, rather than storing a separate counter that could drift —
  the CLI's `fix round N recorded: …` line (`verdict-command.ts`) is
  where the Client sees it.

  A worker's brain is **not** a `verdict()` parameter
  (`contract/surface.ts`'s `Foreman.verdict` takes only `taskId`,
  `ruling`, `note`) — `createForeman` remembers which brain a `do()` call
  on *that same instance* used, per task id, and reuses the exact
  instance for a same-process fix (this is how the contract tests, which
  create one `Foreman` and call `do()` then `verdict()` on it, exercise
  the fix path against `fakeBrain()` without any brain-passing seam in
  the interface). Across processes — the real shape of `fabrica do` then
  `fabrica verdict` by hand — that memory doesn't exist, so it falls back
  to `defaultBrainAdapter()`, the same real adapter `do()` already uses
  by default via the CLI.

## Files

| File | Holds |
| --- | --- |
| `errors.ts` | `ForemanError`, with codes `no-brain`, `invalid-attempts`, `missing-check`, `gate-baseline-unreadable`, `commit-failed`, `unknown-task`, `not-delivered`, `already-closed`, `invalid-verdict`, `missing-note`, `attempts-exhausted`. |
| `check.ts` | Runs the check command; refuses up front when the `check.sh` convention applies and there's no script. |
| `resolve-check.ts` | Picks the check command: a registered project's `check`, or the `check.sh` convention. |
| `gate-changes.ts` | Compares `check.sh` against the task's pinned `baseCommit`, for rule 9's undeclared-change detection. |
| `attempts.ts` | The counted retry loop; builds each correction brief from the previous check's failure output. `initialSession`/`startAttempt` (verdict's fix path) resume a session and continue attempt numbering instead of starting cold at 1. |
| `commit.ts` | Commits whatever a Worker left in the worktree onto the ProductionLine's branch, before teardown - unconditionally; it already asks the index directly and no-ops when nothing is staged. Runs for every outcome, `discarded-protected-path` included - see "Rule 9: blocked by CI, not by Fabrica's own mark" above. |
| `delivery.ts` | Builds the `Delivery` object and its `delivery.md` rendering, plus `buildCommitFailureDelivery` for the one path that isn't a normal outcome - the pre-teardown commit itself failing. |
| `do.ts` | `doTask` — the orchestration described above. |
| `verdict.ts` | `recordVerdict` — rule 6, described above: closes on accept/wrong, re-enters the same line and worker on fix. |
| `queries.ts` | `deliveryOf`, `receiptsOf`, `eventsOf`, `statusOf`, `latestDeliveredDetails` — all read from `events.jsonl`, and all key off the *last* matching event so a fix round's second `"delivered"` (or a later verdict) is what's read back. `fixRoundOf` instead counts *every* `"verdict-recorded"` event with `ruling: "fix"`, since every round matters, not just the latest. |
| `foreman.ts` | `createForeman` — assembles the above into the `Foreman` shape, including the per-instance task→brain memory `verdict()`'s fix path uses. |

`GateResult`, `Receipt`, `Delivery`, `FabricaTask`, and `Foreman` itself
are declared once, in `contract/surface.ts`, and imported into this
module's files as types (issue #45) — there is no local `types.ts` here
to keep in sync by hand any more.
