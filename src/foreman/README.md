# The Foreman

`src/foreman/` is the real implementation behind `createForeman` in
`src/index.ts` (issue #7, "the loop: `fabrica do`"; issue #45 moved the
public entry point here from `contract/`). It is the delegator LANGUAGE.md
calls the Foreman: it registers a task, cuts a ProductionLine, runs a
Worker for a counted number of attempts, verifies the result with the
project's own check, hands a configured green branch to Inspector, and
writes either a delivery or a recorded refusal. It wires `src/record`,
`src/line`, `src/brain`, `src/config`, and `src/inspector` into the one loop SPEC.md calls
"fabrica do". It is pure code: it delegates and counts, it never decides
anything a model should decide instead.

## `createForeman({ recordHome, caps?, brain? })`

```ts
const foreman = createForeman({ recordHome: "/Users/ari/.fabrica" });
```

- **`recordHome`** — where the record lives (`src/record/README.md`). Every
  task this Foreman touches reads and writes under here; nothing in this
  module ever falls back to a fixed default path.
- **`caps`** — `{ perTaskUsd?, perDayUsd? }`, `contract/surface.ts`'s
  `Caps`. CONTRACT rule 10 ("It cannot outspend you"), enforced on every
  task, resumed round, and fix round this Foreman starts - see "Rule 10:
  spending caps" below. Omitted, no cap applies.
- **`brain`** — used by `verdict()`'s "fix" path and by `answer()`, as a
  fallback for when this instance never saw a `do()` call for that task.
  See "`verdict(taskId, ruling, note?)`" below for why `verdict()` itself
  has no brain parameter of its own, and "The ask-first seam" for
  `answer()`'s identical reasoning.
- **`inspector`** — an optional test seam for Inspector's handoff. Omit
  it in production to use the installed command; pass a fake to test the
  three Inspector verdicts without a real command or GitHub.

The return value satisfies `Foreman` (`contract/surface.ts`): `do`,
`answer`, `deliveryOf`, `receiptsOf`, `verdict`, `status`, `events`,
`recordCost`, `recordPath`.

## `do(taskText, { project, attempts?, brain? })`

One call runs the whole loop to completion - register, cut, work, check,
possibly retry, deliver or refuse, tear down - and only then resolves.
That is a deliberate simplification, not an oversight: see "Why `do()` doesn't
return early" below.

1. **Registers and asks-or-proceeds** (`ask.ts`'s `registerAndAsk` -
   issue #8): a new `taskId`, `request.md` written verbatim via
   `src/record`'s `registerTask`, a `task-received` event, then
   `brief.md` written (identical to the request at this point - there
   are no answers yet to fold in). The brain then gets one pass at the
   bare task text, no `workdir` (see "The ask-first seam" below). If it
   comes back materially ambiguous, `questions-asked` is appended and
   `do()` returns `{ id, state: "asking" }` right here — steps 2 onward
   never run, and no ProductionLine is ever cut. `fabrica answer <id>
   -m "<text>"` (`answer.ts`) is what resumes a task that stopped here.
2. **Cuts a ProductionLine** via `src/line`'s `createProductionLine`,
   passing `project` straight through as a filesystem path — the root of
   the Client's own git checkout. The Client's checkout is never written
   to (CONTRACT rule 1); everything from here on happens in the
   ProductionLine's `workdir`. A `"line-cut"` event is appended the
   moment the line genuinely exists (details: `branch`, `reopened`) —
   that event, and nothing else, is what tells a later resume it must
   reopen this branch rather than cut a new one; see "The ask-first
   seam" below.

   A window still separates the two: `createProductionLine`/
   `reopenProductionLine` returning is not the same instant as the
   `"line-cut"` append a few lines later. If the process dies in that
   gap, the branch and worktree are genuinely on disk but the record
   has nothing proving it, so the next round for this taskId still
   reads `isRetry === false` and calls `createProductionLine` again.
   That call finds the same task's worktree path already occupied and
   refuses loudly with `LineError("workdir-exists")` naming the path —
   the same kind of refusal `createProductionLine` gives any other
   taskId collision — rather than silently reusing or corrupting it.
   That refusal is terminal, not a hiccup to retry through: the task is
   stuck until a human clears the leftovers by hand, because every
   later `fabrica answer <id>` reads `isRetry === false` again and hits
   the same `workdir-exists`. Clearing the worktree alone isn't enough
   either - `git worktree add -b fabrica/<taskId>` then fails on the
   branch instead, since the branch survived the crash too. Recovery is
   both halves, run in the Client's own checkout: `git worktree remove`
   (or `git worktree prune`) for `recordHome/tasks/<taskId>/worktree`,
   *and* `git branch -D fabrica/<taskId>`.

   The window stays open because closing it would mean making a `git
   worktree add` and a record append atomic, and nothing here offers
   that; a crash landing in a few-line gap is rare enough, and its
   failure obvious enough, that documenting it beats building machinery
   to prevent it.
3. **Chooses who judges each attempt** (`judge.ts`, issue #64). Fabrica
   never runs a project's check on the host: the check command is a file
   the Worker just edited. Two modes:
   - **Inspector** - Inspector is installed and the task's base commit
     has `.inspector.json`. Each attempt is committed and handed to
     Inspector (`-branch fabrica/<taskId>`); its containerized run is the
     verdict. Fabrica runs no check of its own and records none.
   - **Self-test** - otherwise, never a refusal. The check
     (`resolve-check.ts`) runs once per attempt inside the Worker's own
     box (the adapter's `CheckBox`), and refuses before any Worker runs
     if there is none (`requireCheckCommand`). That is the builder
     checking the builder, so a green delivery says "self-tested in the
     worker's box; no Inspector; not independently checked" and leaves
     the push to the Client. A box that cannot run the check (exit 127,
     no Docker) is a `not-verified` delivery, never a red.
4. **Runs the attempt loop** (`attempts.ts`): calls `brain.work(...)`,
   then the judge, for up to `attempts` rounds. Red (Inspector's report,
   or the box's output) is the next attempt's correction brief; green
   stops early. See "How `attempts` actually behaves" below — it is not
   simply "retry until green."
5. **Commits, hands off, builds, and validates the delivery**: any changes
   still sitting uncommitted in the worktree are committed onto the
   ProductionLine's branch (`commit.ts`) before that worktree is
   destroyed - see `src/delivery/README.md`'s "files-list-vs-teardown
   decision" for why. This runs for every outcome uniformly: the work
   stays committed on the ordinary `fabrica/<taskId>` branch, exactly
   like any other outcome, whether or not it touched the project's
   checks and whether or not that was declared. Fabrica runs no check of
   its own over whether the gate changed (CONTRACT rule 9) - it never
   has a watch to skip or a mark to withhold - see "Rule 9: blocked by
   CI, not by Fabrica's own mark" below.
   In Inspector mode every attempt records `inspector-called` and invokes
   Inspector on this checked-out branch before a delivery exists. This
   requirement survives every fix round; any final config blob that
   differs from the base commit, including deletion, produces a refusal
   rather than letting a Worker weaken or skip its own inspection.
   Inspector's green report proceeds to the normal delivery; a red report
   on the last attempt becomes an `inspection-red` delivery with its report in both the
   delivery and `inspection-finished` record event, so the Client can
   rule `fix` and reopen the same warm Worker and branch. A refusal is
   neither green nor red: it records `inspection-finished` with the
   refusal reason, leaves no delivery for a Client verdict, and reports
   task state `refused`. A fix-round refusal supersedes the earlier red
   delivery rather than exposing that stale result again. Refusal is
   terminal for that *round* - there is no verdict to repair toward, so
   nothing more happens by itself - but it is not terminal for the task:
   as long as some real delivery sits behind it, the Client's own `fix`
   runs the same warm worker again with the refusal's reason as its
   correction (see `verdict()`'s own section below). Only a refusal with
   no delivery anywhere behind it is a genuine end, closable by `wrong`.
   A self-tested task records `inspection-skipped`, with the reason (no
   `.inspector.json` at the base commit, or Inspector not installed),
   before its first attempt. Heartbeats continue while Inspector is
   running so a valid wait is not reported as silence. Those events are
   also what tells the Client which mode judged a task: `fabrica
   status` and `fabrica log` read them back (issue #111, `src/cli/
   render.ts`'s `checkModeFromEvents`) so a green Inspector reached and
   a green the worker gave itself never read the same.

   One exception to "every attempt": a `fix` round whose Worker left the
   branch exactly where it already was - no new commit versus the HEAD
   this round's line was reopened at - is never handed to Inspector or a
   self-test check at all (`judge.ts`'s `skipIfUnchanged`, two fixes in
   the fix-round path). Re-handing an identical, already-reviewed commit
   to Inspector only draws a refusal; a self-test re-run of the same
   workdir could only repeat its own last answer. The round still
   delivers plainly, as outcome `"nothing-changed"` (`delivery.ts`'s
   `buildNothingChangedDelivery`) - a `"delivered"` state like `"done"` or
   `"inspection-red"`, open for the Client's verdict like any other.

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
6. **Destroys the ProductionLine** in every case — success, failure, or a
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
two — only which command the self-test runs in the Worker's box.

## "Run only the tests you touched" is a project setting (issue #142)

The Client's standing ruling: a Worker runs the tests covering what it
touched, not the project's whole suite. The project's own check runs in
full afterwards — in the Worker's box, or by Inspector — so a Worker
re-running everything itself buys nothing and costs minutes on every
attempt.

Before this it had to be typed into each task's text. Now each project
carries it:

```toml
[projects.spending-app]
path  = "/Users/ari/inkling-umbrella/spending-app"
check = "bin/ci"
onlyTouchedTests = true
```

Three things make it a *standing* ruling rather than one more optional
field:

- the loader defaults it to `true` (`src/config/load.ts`), so an entry
  written before the field existed is governed by it too;
- `fabrica register` writes the line out explicitly, so the Client sees
  the knob when his project is registered and has a line to flip;
- a project nobody registered at all — every contract fixture, and a
  bare `fabrica do --project <path>` — gets it as well.

Two ways out, both the Client's own: `onlyTouchedTests = false` in the
project's entry turns it off for good, and a task that asks for the full
suite in its own words turns it off for itself (and only itself).

`touched-tests.ts` is both halves. `onlyTouchedTestsFor` answers the
question for one round; `workerBrief` is what every round calls to turn
the task's own words into the brief a Worker receives — rule 11's
standing prefix plus, when this project and this task both leave it on,
`ONLY_TOUCHED_TESTS_NOTICE`. All three brief-building paths (`do.ts`'s
first round, `answer.ts`'s resumed round, `verdict.ts`'s fix round) go
through that one function, so they cannot drift: before this, each one
applied `withStandingQuestion` itself, and a conditional notice resolved
three times is a notice three places can get wrong. `attempts.ts` still
re-applies `withStandingQuestion` to its correction brief, which is a
no-op on an already-prefixed brief — the guard keys on the fixed prefix,
which the conditional notice sits *after*, so a nested re-application
can neither double rule 11's prefix nor silently drop this notice.

The match for a task's own opt-out is deliberately narrow — four literal
spellings of "run the full suite", case-insensitive. A looser one would
turn ordinary task text into an accidental opt-out, and the downside of
missing a spelling is small: the notice is advice to a Worker, not a
restriction on it, so a task that misses still gets what it asked for by
the Worker simply running the tests it wants.

## The issue a task names is fetched once and carried in full

`fabrica do "<task text>" --project <p> --issue <N>` used to mean one
thing only: put `Closes #N` on the pull request. It now also means "read
#N" — `task-issue.ts` fetches that issue's title, body and comments from
GitHub at registration and every round's brief carries them verbatim, so
a task worded "do issue #142 as written" never has to ask what #142
says, and nobody has to paste an issue's text into a task to get it to
the Worker. HANDBOOK.md's case 1 tells the chat session exactly that.

Five decisions, all the Client's:

- **Which repository.** A bare `--issue N` resolves against the
  project's `origin` remote — the same remote every task branch is cut
  from (`src/line/cut.ts`) — read as `owner/repo` out of its URL
  (`src/register/origin.ts`'s `ownerRepoFromOriginUrl`). `owner/repo#N`
  and a pasted issue URL are explicit overrides. An origin that is not
  on github.com has no repository to resolve a bare number against, and
  is refused naming those two spellings rather than asked about on
  api.github.com as if its last two path segments were an owner and a
  repository.
- **Fetched once, then frozen.** The record is append-only and a task
  answers the request as it was made, so the issue is read exactly once,
  at registration, and written to the task's own `issue.md`. Every later
  round — a resumed round, a fix round in another process — reads that
  file (`taskIssueText`) and asks GitHub nothing. An issue edited
  afterwards is a new task.
- **Verbatim and in full, or not at all.** No truncation, no summary,
  on any round. Past a hard 64 KB ceiling of title plus body
  (`src/github`'s `MAX_ISSUE_BYTES`) the task is refused at
  registration, naming the real size — a Worker silently handed half an
  issue would answer half a request, and nothing downstream would know.
- **A failure refuses before anything is cut.** The fetch sits after the
  cap and meter guards and before `brain.ask()`, inside the same
  `recordingFailure` wrapper, so an unreadable issue cuts no
  ProductionLine, spends nothing, lands on the record as `task-failed`
  with the cause, and makes `fabrica do` exit non-zero with GitHub's own
  explanation. Comments that cannot be read refuse the same way, and on
  purpose: an issue carried without its amendments is a superseded
  request, which is worse than a refusal because nothing downstream
  would know.
- **The comments are part of the issue**, under the heading
  `## Amendments and rulings on this issue, in order`
  (`COMMENTS_SECTION_HEADING`), oldest first, in GitHub's own order.
  The Client's four rulings on them, each visible in `renderIssueFile`:
  human-authored comments only, with automation's named by author and
  date on one "left out" line rather than quoted, since a bot's words
  would read to a machine as a ruling and a dropped comment nobody can
  see is indistinguishable from a comment nobody made; no cap on the
  count and the oldest never dropped, because the ordering is the point;
  the *current* text of an edited comment, with both its posted and
  edited dates; and the heading emitted even for an issue with no
  comments, followed by an explicit "No comments on this issue as of
  `<fetch time>`." — which is why `FetchedIssue`'s `comments`,
  `omittedComments` and `fetchedAt` are required fields rather than
  optional ones: "none" has to stay distinguishable from "not fetched",
  and an `IssueReader` that forgets them fails to compile. A single
  comment past `MAX_COMMENT_CHARS` (4000 code points — not bytes, and
  not UTF-16 units, so a cut never splits a character in half) is cut
  with a `[truncated: ...]` marker naming the comment, its author, its
  real length and how much was left out — the same opening word as every
  other marker Fabrica leaves where it shortened something
  (`src/ci/logs.ts`'s `tailOf`, `src/inspector/run.ts`'s report tail),
  so one grep finds them all. It keeps the *first* 4000 characters where
  those two keep the last: a log's useful end is its tail, a ruling's is
  its opening.

The token is the one Inspector publishes with — `GITHUB_TOKEN`, else `gh
auth token`, resolved in `src/inspector/run.ts` so the two sides can
never disagree about which token Fabrica has. Nothing here spawns a
process: the call is a plain HTTPS request (`src/github/`), which is also
what keeps `no-host-check.test.ts`'s "nothing but git" rule true for this
module. See `src/github/README.md` for why `gh issue view` was not used.

Two things travel on the record, not through a parameter: `issue` (what
a pull request closes — a bare number, or `owner/repo#N` when the issue
is somewhere other than where the pull request is opened, which is
GitHub's own documented spelling for a cross-repository closing keyword)
and `issue.md` (the words). `do.ts` and `verdict.ts` both read them
through `storedClosesIssue`/`taskIssueText`, so a first round and a fix
round can never disagree about what a task closes or what it was asked
to do.

The `--issue` flag is the only path that fetches. A task text's own
`Issue #N:` prefix still closes the issue (`pr-body.ts`'s
`issueNamedByTaskText`) but reads nothing: that prefix means the Client
wrote the task out himself, and a prefix silently turning into a network
read would make an offline `fabrica do` fail on task text that works
today.

## The knowledge-base notes a project names

A project can name notes from a knowledge base it keeps elsewhere
(`projects.toml`'s `[projects.<name>.knowledge]`: a `path` and a list of
bare note names), and every brief on that project carries their words in
full, each under its own front-matter title as a second-level heading,
after the task's own words and inside the standing prefix. The reading
and the rendering are `src/knowledge/`; the round's half is
`task-knowledge.ts`, two functions apart on purpose:

- **`knowledgeNotesFor` reads them, before the line exists.** Every
  caller runs it before `createProductionLine`/`reopenProductionLine` —
  `ask.ts` at registration, `do.ts`'s `productionRound`, `verdict.ts`'s
  `runFixRound`. That is what makes the Client's condition true: a
  knowledge base that isn't there, a `notes/` folder that isn't there, a
  note with no file, or a note with no front-matter title fails the task
  with `ForemanError("knowledge-unavailable")` naming which, with no
  ProductionLine behind it and nothing spent, recorded as `task-failed`
  by the `recordingFailure` wrapper every one of those sites is already
  inside.
- **`withKnowledge` puts them in the brief**, idempotently, the way
  `withIssueText` does — and is where the brief's own size ceiling
  (`src/knowledge`'s `MAX_BRIEF_BYTES`) is enforced, since a note is
  carried whole or not at all. Past it, the refusal names the notes and
  the overage rather than handing over a shortened one. Checked only
  where notes are added: that is the only place that can say what to
  take out.

**Read fresh every round, never frozen.** This is the deliberate
opposite of the issue a task names (above), and the difference is what
each of them *is*. The issue is the request, which must not change under
a running task. A knowledge note is not the request — it is what the
project knows today, so a note corrected between rounds is one the next
round should read corrected. Nothing about it is written to the record,
and `brief.md` still holds only the task's own words, the same way the
standing prefix isn't in it either.

The clarifying step gets the same section (`ask.ts`), for the same
reason it gets the issue: the step deciding whether a task is clear
should read what the work will read.

## Rule 9: blocked by CI, not by Fabrica, and not watched by Fabrica either

Three earlier designs here, all superseded by Client rulings. First, an
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
the detection, or a Worker clever enough to evade it, would mean the
rename never happens, and CI sees an ordinary branch name and waves it
through. The thing being policed was writing its own accusation.

Third, `gate-changes.ts` kept the rename gone but kept the detection: it
still asked git, on the host, whether `check.sh` in the workdir differed
from the task's pinned `baseCommit`, and still forced a dedicated
outcome naming the violation outright — recorded honestly, changing
nothing about enforcement (already CI's job by then), but still a
host-side watch Fabrica ran over a file the Worker just edited.
Overturned by the same Client ruling that removed every other
host-side check (issue #64, 2026-10-08, "Fabrica runs no project check
on the host"): `gate-changes.ts` is deleted, `requireGateBaseline` and
`gateWasTouched` along with it, and `Receipt`/`Delivery["outcome"]` no
longer has that dedicated member at all - only `"done"`, `"failure-report"`,
and `"cap-stopped"` are left on `Delivery`.

So today Fabrica detects nothing about rule 9, full stop: whatever a
Worker left in the worktree, committed or not, ends up on the ordinary
`fabrica/<taskId>` branch like any other outcome, declared gate change
or not, and Fabrica does not compare it against anything. The only trace
of rule 9 left on Fabrica's side is `gateChanges` itself — the Worker's
own stated declaration, carried onto the delivery
(`gate-declarations.ts`'s `mergeGateDeclarations` keeps an earlier
round's declaration from being lost by a later round that leaves that
gate alone, while the newest declaration of a gate that WAS declared
again is the one that stands), never verified against the diff.

**Detection and enforcement both live outside Fabrica, in
`.github/workflows/rule9-gate.yml`.** It queries the GitHub API for the
pull request's changed-file list - never a checkout, never `git diff` -
for whether it touches a protected path (`check.sh` today, the same file
`gate-changes.ts` used to watch, plus `.github/workflows/**` itself; the
list is one `PROTECTED_PATHS` value in the workflow file, easy to extend
for a project with a different check convention). This needs nothing
from Fabrica: not `delivery.outcome`, not a branch name, not any record
file. It works identically for a human contributor's PR and for a
Worker's, and nothing in Fabrica can blind it, because nothing in
Fabrica feeds it. It deliberately blocks a *declared* gate change too,
not only an undeclared one — a change to the thing that decides whether
work passes deserves the Client's eyes every time; Fabrica's own
delivery record still tells the two apart for the Client's benefit
(`gateChanges`), the CI check does not need to.

**Test-change review, now Inspector's to clear.** Issue #96 adds a third,
separately-worded workflow pass for `*.test.ts`, after the contract pass. A
contract test is a contract change first and keeps that message; any other
test change says it changes what Fabrica considers correct. What clears such
a change is Inspector's examiner: it posts a commit status named
`inspector-tests` on the pull request's head commit, and a `success` there
clears every changed `*.test.ts` in the pull request at once - the judgment
is per commit, not per file, because the examiner reads the whole proposed
change. Anything else keeps needing the Client, with its own wording for each
cause: a non-success state, no such status at all, and - failing closed - a
status the job could not read. A pending state is red deliberately and
without waiting: the gate re-runs on every push, and Inspector posts its
statuses before it moves the branch, so pending means something went wrong
rather than "not yet". The status is only read once a changed test file has
actually been found, so a pull request touching no test is never failed by a
status it has no use for. The job therefore declares `statuses: read`
alongside `pull-requests: read`, and nothing about this clearance touches
rule 9's own pass or the contract pass - neither is Inspector's to clear.
Still a stopgap: it goes away entirely when the examiner fully replaces it.
This pass is unrelated to `gateChanges`: it reviews every pull request's test
changes, declared or not, independent of whatever a Worker did or didn't say
about its own check-script edits. It also needs the examiner to actually be
asked for a judgment - that is a `testPaths` entry in the project's
`.inspector.json`, a Client-owned file Fabrica never edits.

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
merge itself. A third, temporary pass then checks `*.test.ts` (issue #96):
contract tests retain the earlier contract message, while any other test
change is cleared only by an `inspector-tests` commit status of `success` on
the pull request's head, and otherwise needs the Client's direct review. The
workflow file's own header comment owns that reasoning, and
`contract/rule9-gate.contract-paths.test.ts` proves the pattern lists, the
distinct wording, and all four outcomes of that status read are there. The
job's `permissions:` are scoped to `pull-requests: read` plus
`statuses: read`, the minimum its two API calls need, rather than
inheriting the default token scope. The job name stays
`block-protected-path-change` regardless of any other change to this
file - that exact string is what gets wired into the repository's
required-status-check settings, and a rename silently breaks the
protection. Branch protection is what makes a failing check actually
block a merge — that's a GitHub repository setting, not something this
code can turn on for you; see the workflow file's own header comment.

**A red check here is sometimes the correct outcome.** A PR that edits
the workflow, or touches `contract/` or `CONTRACT.md` (since issue #53),
fails this check itself - by design, every time. A PR touching a test file
fails it too unless Inspector's examiner cleared that commit (issue #96).
GitHub runs the *base
branch's* copy of the workflow, so the branch's own version never
executes and nothing committed on the branch can turn that check green;
the only things the running job reads about the PR are the list of
filenames it changed and the commit statuses posted on its head - neither
of which the branch's own contents can write. Which leaves exactly one way
for a protected-path change to go green - change
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
returns immediately while work continues in the background, writing to
the transcript as it's produced (issue #70 — see SPEC.md). This module's
`do()` does not do that — once it decides
to proceed, it runs the whole loop to completion before resolving. (The
one early return is the ask-first seam below, and it isn't detachment:
nothing is left running, because no ProductionLine was ever cut.)

That's deliberate, not a shortcut taken by accident: the contract tests
call `await foreman.do(...)` and immediately inspect the final record
result. For the unconfigured projects those tests use, that means
`deliveryOf` and `receiptsOf`; a configured Inspector refusal instead
leaves no delivery but records its receipts and reason before the promise
resolves. "Detached" is a property of the CLI a
Client types at — spawning the loop in a background process and
returning control to the shell right away — not a property this
programmatic seam can have while staying testable synchronously.
`src/cli/` (issue #47) makes that distinction concrete: `fabrica do`
wraps this same `do()` in a detached child process without reshaping
anything here - `src/cli/README.md` owns the mechanism.

## The ask-first seam (issue #8)

SPEC.md step 2: v1's default is to ask a clarifying question before
working on a materially ambiguous task, and the ask-first dial itself is
fixed at "ask" - not built as a setting. "Materially ambiguous" is the
load-bearing phrase, defined the same way everywhere it's stated in this
codebase: an ambiguity that would change what gets built, not one a
reasonable person would resolve the same way every time. Getting this
wrong in the cautious direction - asking about everything - is its own
failure (a tool nobody uses), so the line is drawn narrow on purpose.

**Why this needed a second `Brain` call, not a flag on `work()`.**
`Brain.work()` promises that by the time it resolves, the work described
in `brief` has actually been done inside `workdir` (`src/brain/README.md`)
- it is not a "maybe ask, maybe work" call, and SPEC.md's own step
ordering places "Clarify-or-proceed" (step 2) *before* "Isolates" (step
3): a materially ambiguous task should never pay for a ProductionLine at
all. So `Brain.ask(brief)` is a second, narrower socket: no `workdir`
parameter, because at this point in the loop there is no ProductionLine
yet to hand one from - CONTRACT rule 1 holds here by construction, not by
trusting a brain's good behavior. It returns `{ questions?: string[] }`;
empty or omitted means proceed straight to work.

**`ask.ts`'s `registerAndAsk`** owns steps 1-2 of `do()`: register the
task, then call `brain.ask(taskText)`. A non-empty result gets recorded
as `"questions-asked"` (details: the questions, plus `project`,
`totalAttempts`, and `explicitAttempts` - a later `fabrica answer` has no
ProductionLine to remember these on, since none was ever cut, so they
ride on this event instead) and `doTask` returns `{ id, state: "asking" }`
immediately - no ProductionLine, no Worker, no check ever runs. If
`brain.ask()` itself throws instead of returning (the reference
adapter's documented credential gap is today's live path), that is
recorded too - `"ask-failed"` (details: `{ error }`, the thrown error's
own message) - before the error is rethrown unchanged, so every direct
caller still sees the real exception and only the record gains a trace
of it (Client ruling, issue #8 follow-up: "a failed task must never look
like a started one" - `queries.ts`'s `stateOf` reports this state as
`"failed"`, and `src/cli/wait-for-ask-outcome.ts` watches for it
directly rather than only ever finding out via a timeout). An empty
result falls through to `runProductionRound` (do.ts), the exact same
isolate/work/verify/inspect/result pipeline this file runs, now factored
out so `answer.ts` can reach it too.

**`answer.ts`'s `answerTask`** is what `fabrica answer <id> -m "<text>"`
calls: find the task's last `"questions-asked"` event (refuses with
`ForemanError("no-questions-pending")` if there isn't one), append the
round to `answers.md`, re-derive `brief.md` as `request.md` plus every
answer so far, append `"answers-given"`, then call `runProductionRound`
with the extended brief - what the *worker* receives. It never calls
`brain.ask()` again, regardless of whether the extended brief would
still look ambiguous - the dial is fixed, not a negotiation loop.

`runProductionRound` itself keeps two things distinct that a first-ever
round never had to: `brief` (what `brain.work()` gets - the full,
possibly-extended text) and the delivery's own `taskText` (what
`buildDelivery`'s `summary`/`delivery.md` describe - always
`request.md`, read back from the record rather than aliased to `brief`).
For a resumed task `brief` is `request.md` plus the whole
`"## Clarification"` Q/A block; without this split, `delivery.summary`
(`Completed: ${taskText}`) and `delivery.md` would turn into that same
multi-paragraph blob instead of staying one line. `verdict.ts`'s fix
path already drew this exact line (`readTaskFile(..., "request.md")` for
`taskText`, `brief.md` only for the worker's own brief) - mirrored here
rather than reinvented (Client ruling, issue #8 follow-up).

`ForemanError("already-answered")` - v1's "one clarification round by
default," enforced here rather than left to silently re-ask - fires only
for a round that actually *completed*: a `"delivered"` event or an
Inspector refusal after the last `"answers-given"`, not merely
`"answers-given"` existing. A refusal completes the round without
creating a Client delivery because Inspector reached no verdict to fix.
That distinction matters because `runProductionRound` can throw before
ever reaching either result (a missing check command, a moved project
path, an unreachable brain) - if the guard keyed on `"answers-given"`
alone, a task
whose resumed round failed for an infrastructure reason would become
permanently unresumable the moment the Client tried again, with their
answer already on record and no way back in. Retrying past a genuinely
incomplete round reuses the same taskId's `runProductionRound` call,
passing `isRetry: true` so it picks `reopenProductionLine` over
`createProductionLine` - the branch that failed attempt already left
behind. `isRetry` is an explicit signal `answerTask` derives from this
exact taskId's own record (Client ruling: a same-named
`fabrica/<taskId>` branch's mere existence in the project used to decide
this, and was overturned as the weaker evidence - a taskId is unique
only within one record home, while branches live in the project, so a
foreign or leftover branch sharing that name could otherwise get
silently adopted and committed onto on what was actually a task's
*first* round, exactly where `createProductionLine`'s own loud refusal
is supposed to apply; see `do.ts`'s own comment on `runProductionRound`
for the full reasoning). `doTask`'s first-ever call always passes
`isRetry: false`.

The record entry it keys on is `"line-cut"`, which `runProductionRound`
appends as soon as `createProductionLine`/`reopenProductionLine` returns
- proof the line genuinely exists, though not in the same instant it
started existing (see the window in step 2 above) - and **not**
`"answers-given"`, which `answerTask` writes *before* calling
`runProductionRound` at all (Client ruling, PR #69 review). The two come
apart in two places. The first strands the task: a resume that dies
on the cut itself (the project moved or was renamed, a stale
`.git/index.lock`, any other `git worktree add` failure) leaves
`"answers-given"` on the record with no branch anywhere to match it.
Keyed on the answer, `isRetry` would then be permanently true, so every
later `fabrica answer` would reopen a line that was never cut and fail
with `LineError("no-such-branch")` forever, even once the Client fixed
the real cause - the same permanently-stuck-task shape the
`"already-answered"` guard above exists to prevent, one step earlier.
Moving the `"answers-given"` append after the cut instead was considered
and rejected: a second answer would then append a duplicate round to
`answers.md`.

The second place they come apart is the crash window in step 2 - the
line is cut, but the process dies before the append. That one cuts the
other way: keyed on the answer, `isRetry` would be true and the resume
would reopen the branch that really is there, where keying on
`"line-cut"` leaves the task needing the manual cleanup step 2
describes. It still loses the argument, because it is the rarer case and
the one whose failure is loud, named, and fixable by hand in two
commands - against a first case where keying on the answer would strand
the task with no way out at all.

What the guard guarantees is that the task stays resumable and keeps
reporting its true error - not that retrying succeeds. Reopening does
not re-cut from the project's current HEAD, so a failure baked into the
branch's history at the point it was first cut (no `check.sh` in that
commit, a project path already wrong then) throws identically every
time; only a failure unrelated to that history (an unreachable brain, a
transient error) clears on retry. A failure *before* the cut is the one
fully clean case - nothing is committed anywhere yet, so the retry runs
as a genuine first round.
`contract/surface.ts`'s `Foreman.answer(taskId, text)` has no `brain`
parameter, the same reasoning as `verdict()`'s fix path below: a
same-process `do()` call that ended up `"asking"` already had its brain
remembered by `createForeman`'s per-task map; a fresh process (the real
shape of `fabrica do` then `fabrica answer` by hand) falls back to
`defaultBrainAdapter()`.

`brief.md` is written upfront, before asking, for two complementary
reasons — see the comment above the `writeTaskFile` call in `ask.ts`:
`fabrica answer` (issue #8) is why it exists *now*, so a clarify round
only has to append to `answers.md` and re-derive `brief.md`, instead of
creating the file itself; per-project lessons (issue #19) are why it must
be *stored* rather than derived on demand later. Today, for a task that
never asks, `brief.md` stays byte-identical to `request.md`, because v1
doesn't prime lessons yet.

The CLI side of this - what `fabrica do` prints, on which stream, and
with which exit code, once a task asks, fails to ask, or proceeds - is
owned by `src/cli/README.md`'s step 5, not restated here.

## Why receipts and deliveries live on `events.jsonl`, not their own file

`src/record`'s `TaskFile` union has no slot for a Delivery object or a
list of Receipts — only markdown/text files a person reads
(`delivery.md`, `transcript.log`, …). Rather than invent a place to store
structured data outside the record, `do()` puts the whole `Delivery`
object and that round's `Receipt[]` into the `"delivered"` event's
`details` field (alongside the `project` and `baseCommit` a later fix
round needs, plus the `totalAttempts` `do()` ran with, kept as a record
only - `queries.ts`'s `DeliveredDetails`, and "What a fix costs" below).
An Inspector refusal has no Delivery, so its `"inspection-finished"`
event carries the same resume metadata instead. `deliveryOf` returns the
latest delivery unless a newer refusal superseded it. No reader parses
markdown or creates a second source of truth.

### Each round writes its own receipts, and nobody writes history (issue #68)

A `"delivered"` event used to carry the **cumulative** `Receipt[]` -
every receipt from every round so far, re-serialized on every append. Four
fix rounds stored ten sets of receipts, five stored fifteen: growth as the
square of the round count, in a file `src/record/read.ts` parses whole for
every query, which is never pruned, so one heavily-fixed task slowed down
every `fabrica` invocation permanently.

Each event now stores only its own round's receipts, and the cumulative
view is reconstructed on read - `queries.ts`'s `receiptsOf`
(`reconstructReceipts` for a caller already holding the events), which
walks every event carrying a receipt and keys them by attempt number,
**latest wins**. Both sources matter: an attempt that ended with no
delivery (Inspector refused) is only ever on its own
`"receipt-recorded"` event, and a receipt a round corrected after
recording it (the commit-failure path below) is only correct on the
`"delivered"` event. Latest-wins is also what makes a record written
before this change read back exactly as it did - every one of its
`"delivered"` events restates the whole history, so the newest
restatement of each attempt survives, which is the value that delivery
itself reported. Nothing migrates or rewrites the record; read-side
tolerance is the whole mechanism (Client ruling, issue #68).

The one cumulative fact a reader holding a single event can no longer
reconstruct - how many attempts the task has had in all - rides along as
one number, `attemptsSoFar`. `fabrica log`'s delivered line prefers it
and falls back to `receipts.length` for an older event, where the two
agreed by construction.

Rule 9's declarations had the same shape of problem and the same fix:
the event carries `gateDeclarations`, this round's worker passes' own
declarations, and `queries.ts`'s `gateDeclarationsOf` reads every round's
back for `gate-declarations.ts`'s `mergeGateDeclarations` to fold into
the one text the delivery reports - newest declaration per gate named,
rather than a block appended per round forever. See that module's header
for how a gate is named out of a worker's prose and why that reading is
written to fail safe.
`delivery.md` is still written for real deliveries as a human-readable
rendering of the exact same object, matching the same "events.jsonl is
authoritative; everything else is a convenience view of it" design
`src/record/README.md` already documents for `brief.md`.

The one thing the record does *not* store whole is a check's output:
`attempts.ts`'s `gateForRecord` keeps only the tail, behind a marker
naming what was dropped. The whole events file is read and parsed for
every query, so a check free to print any amount can't go in verbatim.

That output is stored in exactly one place: the receipt of the attempt it
judged (`Receipt.checks`). A Delivery's `evidence` used to be a second,
byte-identical copy of the same string on the same event. It is now a
pointer - `delivery.ts`'s `checkEvidence` names the attempt whose receipt
holds the output and shows its first `EVIDENCE_HEAD_LINES` and last
`EVIDENCE_TAIL_LINES` lines, the tail being the larger half for the same
reason `gateForRecord` keeps the tail. The argument for the copy was that
a delivery should stand on its own as one readable thing; the Client
ruled for the pointer plus an excerpt, which satisfies both, with the
receipt as the source (issue #68, 2026-10-22). A caller that cannot name
the attempt gets the output stored as it always was, never less.

The live `GateResult` is left untouched - the next attempt's correction
brief still gets the complete output, because that is what the Worker
needs to fix the failure, and it is never written to the record. The one
reader that needed the delivery's full copy, `queries.ts`'s
`redPublishedChecksOf` (issue #267, what a fix round's worker is told
GitHub found), reads the receipt directly and falls back to `evidence`
only for a record written before this change.

One consequence: the last attempt's `Receipt.outcome` can't be decided
until *after* the attempt loop and the pre-teardown commit both finish
(an attempt that looked "delivered" the moment its check went green can
still turn into `"failed"` a moment later if that commit itself fails -
`round.ts`'s own commit-failure path). Since `events.jsonl` is
append-only, that receipt can't be corrected in place — so `do()`
computes every receipt's final `outcome` before it ever calls
`appendEvent`, and logs the round's batch once on its final result event,
already correct. That is the case `receiptsOf`'s latest-wins keying
exists for: the same attempt's uncorrected receipt is already on the
record as its own `"receipt-recorded"` event, appended before the commit
was even attempted, and the `"delivered"` event's copy is the one that
stands.

## A worker whose network is gone fails now, not in four minutes

The heartbeat does one thing besides saying "still waiting": on every
tick it asks whether the network this attempt's worker box is running on
is still there (`src/brain/relay-health.ts`, a `workdir`-keyed registry
the adapter registers into — nothing added to `Brain`'s ratified
signature). A sentence back means it is not, and then:

- the heartbeat stops — a call known to be doomed must not keep
  reporting that it is still going;
- the adapter stops the worker box (`runContained`'s
  `containerName`/`stopSignal`), so `work()` returns in about a second
  with its own teardown — the relay container, the two throwaway
  networks — still on the ordinary path;
- the attempt fails with that sentence, which names the relay.
  `do.ts`/`verdict.ts` record it as `"task-failed"` like any other
  error, so `fabrica log` says what actually broke.

`withHeartbeat`'s `graceMs` (`DEPENDENCY_GONE_GRACE_MS`, 30s) is the
ceiling for a brain that ignores the stop: past it the attempt fails
anyway. It is deliberately not a replacement for the stop — a worker
left running has to be *stopped*, not merely stopped being waited for.

Why this exists (2026-10-18): a task's relay container exited mid-attempt
and nothing noticed. The box ran on against an address with nothing
listening, heartbeats were recorded for four minutes, and the failure
that finally landed was the worker's own `API Error: Unable to connect
to API (ConnectionRefused)` — true, useless, and naming nothing. The
relay can no longer die that way (`src/relay/README.md`), and this is
the part that does not take the relay's word for it.

## A dropped model call is retried once, and never swapped (issue #199)

Two tasks in two days were lost to `Connection closed mid-response`
(#139, #168): the model had done the work, the answer was on its way
back, and the task died on the last bytes of it. `transport-retry.ts` is
the rule that replaces that:

- a **transport failure** — the call never got an answer — is retried
  exactly once, after `TRANSPORT_RETRY_WAIT_MS` (5s), against the **same
  model**;
- the retry is recorded as a `"transport-retry"` event carrying the
  reason and the failed call's own words, and is **never an attempt**
  (rule 3 counts attempts, not reconnects — this runs inside one turn of
  `attempts.ts`' loop and leaves its numbers alone, so a long task can
  show several of these against one attempt number);
- both calls failing stops the task with
  `ForemanError("model-call-failed")`, naming the model and the error —
  `"task-failed"`, like any other error;
- nothing ever switches to another model. A switch is a decision with a
  record behind it, not something that happens quietly here.

Every model call Fabrica makes goes through it — all three of them:
`attempts.ts`' per-attempt `brain.work()` (`onTransportRetry`, wired to
the event by `do.ts` and `verdict.ts`); `ask.ts`' `brain.ask()`, which
records the same event itself and whose double failure lands as that
task's `"ask-failed"`; and `src/quiz/recheck.ts`' re-check round, the
one model call outside a production round, whose double failure already
leaves its questions outdated and now says which model and why. A fourth
call site added later belongs inside this wrapper too — that is the
rule, not a per-call-site decision.

**What is and isn't a transport failure** (Client ruling 2026-10-23):
retried — a connection closed mid-response, a connect or read timeout,
any 5xx (529's "overloaded" included, covered by *every* 5xx rather than
by naming one provider's spelling), and 429. Not retried — auth
rejections, context-length refusals, and any other request-level refusal:
the API answered, and a second ask gets the same answer.

`transportFailureReason` is an **allowlist**, and the reason matters: a
shape wrongly left out costs one honest failure, while a shape wrongly
let in re-runs a whole worker call — real money, real time, possibly
duplicate work — every time it appears. So an error it does not
recognize is not a transport failure. Three ordering rules hold it
together: a `ForemanError` is Fabrica's own refusal about its own state
and never a dropped call; a status the API actually answered with
decides on its own, either way, so a refusal whose body text happens to
mention a connection is still a refusal; and the text patterns only get
their say after that. Its `STATUS_PATTERNS` list is written against the
two real adapters' own wording — **that is the first place to look when
a transport failure was not retried**, and where a new adapter's own
spelling belongs.

Two placements that are deliberate, not incidental:

- The retry is wrapped **by** the heartbeat (`withHeartbeat(tick, ms, ()
  => withTransportRetry(...))`), not around it. The heartbeat keeps
  ticking through the wait and the second call, so a retrying task never
  reads as quiet — and `withHeartbeat`'s relay-health probe still fails
  the whole thing if this box's network is what died. That failure is
  raised *outside* the wrapper, so `worker-network-gone` can never be
  retried: a dead relay does not come back in five seconds, and it
  already fails honestly and at once (see the section above).
- A retry clears `attempts.ts`' `liveEntries`. That array is what the
  catch-up delivery slices by (`work.transcript.slice(liveEntries
  .length)`), and it is only a prefix of *that* call's transcript. The
  dropped call's live entries stay delivered — they really happened, and
  they are in `transcript.log` — but counting them against the retry's
  own transcript would silently drop its first entries.

## Stopping a task (issue #203) — the one state nothing can reopen

The Client can stop a running task from the live view's `/review` page.
`stop.ts`'s `recordStopDecision` is the record half of that: it refuses
anything not `"working"`/`"checking"` (`ForemanError("not-running")`,
naming the state it is actually in), and otherwise appends one
`"stopped-by-owner"` event carrying who stopped it, which state it was
stopped from, and the worker's last transcript line with its timestamp.

From that moment `stateOf` reports `"stopped"`, and **that state is
absorbing**: the forward pass skips every later event except a
`"verdict-recorded"` one. The reason is the Client's own ruling — his
decision is the fact, and the detached process is being *signaled*, not
asked, so whatever it still manages to append on its way down (a last
heartbeat, a finished check, even a delivery from work it had already
completed) stays on the record for the log to show but must never make
the task look alive again. His own `accept`/`wrong` verdict is the one
thing that still moves it, exactly as for any other task.

`"stopped"` is terminal everywhere that cares: `fabrica status` stops
listing it (nothing is being asked of him, the same reason a closed
task drops off), `fabrica watch` prints its terminal notice and exits,
`fabrica await` returns, and the live view files it under history. The
process half — finding the task's own detached process and sending it
SIGTERM, then SIGKILL after a ten-second grace — is
`src/cli/task-process.ts`, not this module: it needs `ps`, and
`no-host-check.test.ts` fails if anything under `src/foreman` spawns
anything but `git`.

## A recorded failure is absorbing too

`"task-failed"`, `"ask-failed"`, and a `"cap-refused"` that refused a
task's very first start all make `stateOf` report `"failed"` — and, like
`"stopped"` above, **that state then holds**: the forward pass skips
every later event until one of exactly three lands.

The reason is the same one, arrived at from the other direction. A round
appends `"task-failed"` from the top of its own stack
(`task-failure.ts`'s `recordingFailure`), with the heartbeat intervals
around `brain.work()` and the Inspector call both already cleared in
their `finally` blocks — so nothing that round itself does can land
after it. Anything that *does* land came from somewhere else: a second
process holding the same task id, or a straggler from a round on its way
down. Neither is evidence of a live worker, and before this rule any one
of them — a late `"work-started"`, a finished `"check-run"`, an
`"inspector-called"`, an `"inspection-finished"`, an
`"inspection-skipped"` — put the task back to reading `"working"` in
both `fabrica status` and the live view while nothing was running at all.

The three that get through (`queries.ts`'s `CLEARS_FAILURE`):

- **`"verdict-recorded"`** — the Client ruled. `accept`/`wrong` close it
  (issue #143's carve-out is exactly this case); `fix` starts a round.
- **`"answers-given"`** — the Client answered, which resumes the task
  (`answer.ts` deliberately keeps a task whose round *threw* resumable).
- **`"delivered"`** — a round genuinely finished and there is something
  to rule on.

The first two are safe to trust because of issue #123's split: a resume
and a fix round each record their decision **in the foreground**
(`recordAnswerDecision`/`recordVerdictDecision`) before the round itself
is handed to a detached process, so a genuine restart always puts one of
them on the record ahead of that round's own `"work-started"`. No real
restart is missed. `"delivered"` is here for a different reason: a round
that delivers has not thrown, so a delivery can never be a dying round's
straggler — and two rounds *can* hold one task id at once (`fabrica
verdict` and the live view's `/review` page call the same
record-then-spawn pair, so a double submit is enough), where swallowing
the surviving round's delivery would hide work the Client still has to
rule on.

## `verdict(taskId, ruling, note?)` — rule 6, "you get the last word"

A delivered task stays open (`status()` still lists it, as `"delivered"`
or `"failed"`) until this is called. Every ruling appends a
`"verdict-recorded"` event, unconditionally — that event, not any
side-channel state, is what `queries.ts`'s `stateOf` reads to decide
whether a task is `"closed"`.

- **`accept`** — the work is right. Closes the task.
- **`wrong`** — not what was wanted, and not worth correcting. Closes the
  task, same as `accept` — a real outcome the record shows plainly, not a
  failure folded into `"failed"`. The one ruling still allowed when
  Inspector refused before the task ever reached a delivery
  (`queries.ts`'s `refusedWithNoDelivery`) — that state otherwise refuses
  every ruling (`not-delivered`/`inspection-refused`) forever, and `wrong`
  needs none of what the other two would: no delivery details to reopen a
  line from, no verdict to repair toward. `accept` and `fix` stay refused
  there exactly as before. A fix round's refusal that supersedes an
  *earlier real delivery* is a different case: that delivery is still
  there for the Client to rule on directly, so **both** `accept` and
  `wrong` rule on the latest `"delivered"` event as if the later refusal
  had never happened — `recordVerdictDecision`'s
  `rulesOnDeliveryDespiteLaterRefusal` — and the verdict records it,
  marking `"verdict-recorded"`'s own details with `supersedesRefusal:
  true` so the record says plainly that a refusal sits between the ruling
  and the delivery it actually ruled on. `fix` is accepted there too now
  — see its own bullet below for what the round is handed. The same
  exception applies to a task that failed before it ever reached a delivery at all
  — `brain.ask()` threw (`"ask-failed"`), a spending cap refused its very
  first start (`"cap-refused"` before the task ever began), or some other
  error killed it first (`"task-failed"`) — `queries.ts`'s
  `failedWithNoDelivery` (issue #143). Same reasoning, same carve-out:
  `accept` and `fix` stay refused (`not-delivered`), `wrong` alone closes
  it, and a `"delivered"` event anywhere in the task's history (even one
  later superseded by a failed fix round) takes it out of this case
  entirely.
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
  per fix. A completed fix round records **its own** receipts on its own
  `"delivered"` event, with the task's cumulative count beside them as
  `attemptsSoFar` (issue #68, above) — a round that passed over a
  stopped rebase more than once puts all of its passes' receipts there,
  since every pass is this round's. An Inspector refusal appends only
  `"inspection-finished"` and supersedes the prior delivery.
  `queries.ts` therefore reads the latest event appropriate to each
  value rather than assuming every fix re-delivers. The round's
  `priorReceipts` come from `receiptsOf`, which reconstructs the whole
  task's list from every event carrying a receipt, not from the latest
  delivery alone: a refused round delivers nothing, so reading only the
  delivery would restart `startAttempt` on a number the task has already
  used.

  **A round answering an Inspector refusal** (Client ruling: the dead end
  after a refused fix round). When the task's latest word is a refusal
  with a real delivery behind it (`queries.ts`'s
  `refusalAfterDelivery`), `fix` is accepted and the round runs exactly
  as any other does, with two differences. Its brief carries
  `verdict.ts`'s `refusalCorrection` alongside the Client's own note —
  Inspector's reason verbatim, framed as a refusal rather than a
  judgement, and covering both shapes of refusal, because Inspector
  publishes no exit code, marker line or report field that tells "it
  declined before publishing anything" apart from "the check passed and
  a green publication was left incomplete" (both exit 2). Fabrica
  therefore classifies nothing and hands the report over whole; if that
  ever has to be decided in code, the mechanism is
  `src/inspector/consumer-contract.json`, not a pattern match on
  Inspector's prose. Second, the judge is **not** wrapped with
  `skipIfUnchanged`: that wrapper exists because re-handing an
  already-*reviewed* commit only draws a refusal, and a refusal means
  nothing was reviewed — so handing it over again is the retry that can
  succeed, and the only way an unpublished green branch ever gets
  published. A worker told to change nothing (the incomplete-publication
  case) would otherwise deliver `"nothing-changed"` with Inspector never
  called again. `"verdict-recorded"` carries `answersRefusal: true` for
  this case, as bookkeeping; nothing branches on it. A refusal with no
  delivery anywhere behind it is unchanged: only `wrong` closes it.

  This calls `reopenProductionLine` directly rather than going through
  `runProductionRound`, so a fix round appends `"work-started"` but no
  `"line-cut"`. That's fine today - nothing reads `"line-cut"` on this
  path, and the task already got one from its original round - but it
  means `"line-cut"` is not a reliable "this task currently has a live
  line" signal in general: the fix path is a standing exception to it.

  **What a fix costs, precisely**: nothing, on purpose (issue #65). Rule
  3's "three means three" bounds `do()`'s own retry loop — a *machine*
  trying, failing, and trying again unattended — not a correction the
  Client explicitly asked for; nothing happens until he rules `fix`, so
  he is the stop condition, not a counter. `verdict("fix", …)` has no
  ceiling and never refuses. The `ForemanError` code it used to refuse
  with, `attempts-exhausted`, is gone from `errors.ts` entirely: that
  refusal was its only thrower, and `do()` exhausting its *own* budget
  never threw it — per rule 2 ("Done means proven") a red final gate is
  delivered as an honest `failure-report`, never raised as an error, and
  that stays exactly as it is. `project` and `baseCommit` are still
  persisted on the `"delivered"` event's `details` (`queries.ts`'s
  `DeliveredDetails`) so a later fix round can find what it needs to
  reopen the line; the *original* `totalAttempts` rides along as a record
  of what `do()` was given, but nothing reads it for any decision — a
  delivery that somehow lacks it can still be fixed. Each round is counted
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

### A fix round starts by rebasing onto origin's default branch (issue #235)

A `fix` is often ruled days after the task ran. Without this, that round
reopens a branch forked from a commit the project has long since moved
past, and hands Inspector (and a reviewer) a pull request whose diff
makes no sense against today's default branch. So before anything else a
fix round does — before `prepareRound`, before any worker — the task's
branch is brought up to origin's *current* default branch.

`src/line/rebase.ts` is the git (see its own section in
`src/line/README.md`); `fix-rebase.ts` is the policy. Two properties
hold by construction and must keep holding:

- **Host side, git only, never in a worker.** A worker's git mounts are
  read-only by design (`src/containment`), so it could not commit a
  rebase even if asked; and rewriting a branch's history is not a
  judgement call to hand a model. `no-host-check.test.ts` already proves
  nothing under `src/foreman` spawns anything but `git`, which covers
  this too.
- **Nothing is ever pushed.** Inspector owns push-inspect-publish; the
  rebased branch stays local exactly like every other commit Fabrica
  makes.

**What Fabrica does owe Inspector: the tip that publish may lease
against** (inspector#53). A rebase rewrites the branch's commits, so
publishing it afterwards is a *forced* push — and a forced push with
nothing to compare against would overwrite whatever else had reached the
published branch meanwhile. Fabrica is the only side that knows what to
compare against, so it passes it: `inspector run -expected-tip <sha>`,
where the sha is `origin/fabrica/<taskId>` **as the fetch immediately
before the rebase left it** — exactly what `--force-with-lease` compares
against on the remote (Client ruling). `src/line/rebase.ts` reads both
that and the branch's own tip at that one moment (`RebaseOutcome.tips`);
`fix-rebase.ts`'s `publishLeaseAfterRebase` decides, and three rules
settle it:

- **Only when the rebase actually moved the branch.** An unchanged tip is
  a fast-forward and needs no lease. Measured around the rebase alone —
  before this round's worker commits on top — so a round that only ever
  worked is never mistaken for one that rebased. An `already-current`
  round, and any round outside the fix path (`do.ts`, `answer.ts`), never
  carries the flag.
- **Only when origin has a copy to lease against.** A task branch nothing
  ever published has no `origin/fabrica/<taskId>`; the flag is left off
  and the publish goes ahead exactly as it did before. This may never
  become a new way for a publish to fail (Client ruling) — which is also
  why every git read behind it returns `null` instead of throwing.
- **Never after an abort.** A rebase given up on (`markers-remain`,
  `too-many-stops`) or ended underneath (a cap stop, the pause rule) puts
  the branch back at its own last commit, so there is nothing rewritten
  and nothing to lease — and those rounds reach Inspector at all.

The lease is passed as a thunk through `prepareRound` → `inspectorJudge`,
deliberately not resolved up front: on the conflict path the rebase is
still *stopped* when the round's judge is built, and only finishes inside
`runAttempts`' `beforeCommit`. `inspection.ts` records it on
`"inspector-called"` (`expectedTip`, plus `localTipBeforeRebase` when the
branch had moved on locally since it was last published — both, per the
Client's ruling, so anyone asking why a publish refused can see what was
expected).

**Before every fix round, skipped when there is nothing to do.** It runs
each round, not only the first — origin moves between rounds too — and
does nothing at all when the branch already contains origin's tip, so a
reviewer's shas are never churned for no gain.

**A conflict is handled in the round it happens in, in one step.** The
rebase is left *stopped* — still in progress, markers in the working tree
— and this same round's worker is handed the Client's own note *and* the
conflicted file list in one brief
(`fix-rebase.ts`'s `rebaseConflictInstructions`). It resolves the markers
in place; once it returns, the host stages everything and continues the
rebase itself (`finishRebase`, called from `runAttempts`' `beforeCommit`
hook). A round that ends with the rebase finished is an ordinary round
from there on: committed, judged, delivered.

There is deliberately **no** "report the conflict first, hand it to a
worker only after he has ruled on it" step. That is how this started
(the first conflict was aborted and delivered as `inspection-red` with no
worker run at all) and the Client replaced it: it cost him a whole round
to say nothing a worker could not already be told, and it made every
round's shape depend on reading whether the previous delivery happened to
be a conflict report. Nothing branches on that now — **do not
reintroduce the two-round shape.**

Two consequences of letting the host finish the rebase, both deliberate:

- The rebase's own commits keep their original messages — the host does
  not commit this round's work separately, because `git rebase
  --continue` already made the commit. The worker's write-up still
  becomes the pull request's title and body (`inspectorJudge` uses this
  round's `finalMessage`), which is where a reviewer reads it.
- Any *other* edit the worker made in that round is folded into the
  replayed commit by the same `git add -A`. That is the honest outcome of
  "the host stages everything", and the brief tells the worker plainly
  that resolving the conflict is the job.

**A rebase that stops again goes back to the same warm worker, in the
same round.** `continueStoppedRebase` is the one place that decides,
every time `finishRebase` comes back conflicted:

- `new-conflict` (a later commit of the same rebase conflicting on its
  own) — the rebase is left stopped again and `verdict.ts` calls
  `runAttempts` once more, same session, with the new conflicted file
  list, until the rebase finishes. Up to `MAX_REBASE_STOPS_PER_ROUND`
  (5) stops; past that it is `too-many-stops` below. The ceiling is not a
  budget — a `fix` draws from none (issue #65) — it is there so a branch
  that has drifted too far to replay reaches the Client instead of
  looping.
- `markers-remain` — the worker had his note and the file list and left a
  marker behind. Never handed back in the same round: the next
  instruction it needs is his, not another copy of the same one.
- past the ceiling, or markers left behind — `git rebase --abort`, so the
  branch is provably back at its own last commit with a clean tree, and
  the surviving markers are delivered as `inspection-red` (every
  conflicted file and its marker hunks as the delivery's `evidence`,
  capped — see `src/line/README.md`). `inspection-red` rather than a
  failure report because `deliveredState` puts it in front of him, which
  is the point: this is work waiting on his judgment, not the machine
  failing at something it could retry. The delivery deliberately carries
  **no** `inspection` field: that field means "this branch was handed to
  Inspector" (`src/inspector/types.ts`), and this branch never was.

**A stopped rebase never outlives its round.** Whatever ends the round
ends the rebase with it: a spending cap or the pause rule stopping the
loop aborts it before anything is delivered (`"round-ended"`, so the
report says plainly that the conflict is not what stopped the round), and
a round that throws mid-rebase — an unreachable brain, a worker that dies
— aborts it in `runFixRound`'s `finally` (`"round-failed"`). The next
round must never find one in flight: `rebaseOntoOriginDefault` refuses
outright rather than guessing what it was for.

Every stop and every abort lands on the record as a
`"rebase-conflicted"` event (`src/inspector/types.ts`) carrying `stop`,
`left` (`"stopped"`/`"aborted"`) and, where there is one, the reason.
Purely the record saying what the host did — no decision reads it, and
the delivery's own `rebaseConflict` field (`queries.ts`'s
`DeliveredDetails`) is bookkeeping for the same reason.

**The seam this needed in `attempts.ts`.** Finishing the rebase has to
happen after `work()` returns and *before* the attempt's own commit,
which assumes a branch the rebase has stopped moving. `runAttempts`
therefore takes an optional `beforeCommit(attempt)`: return a `Judgement`
and that IS the attempt's judgement — nothing is committed and nothing is
judged — the same shape an invalid write-up already has. The judgement
kind is `"rebase-conflicted"`, and `round.ts` handles it before the cap
and `"unchanged"` branches, unlike those two: a conflict is the fact
about the branch the Client has to rule on either way, and a cap-stopped
report would tell him to raise a cap when the real blocker is a conflict.
A cap stop in the same round still lands on the record as its own event,
so rule 10 loses nothing.

**Why the hand-back loop is `verdict.ts`'s and not `runAttempts`'.** Each
pass over a stopped rebase is a full `runAttempts` call of its own — one
attempt, same session (`initialSession`), attempt numbers continuing from
`priorReceipts.length` plus the passes already made. That keeps rule 3's
counted loop exactly as it was (nothing uncounted loops inside it) and
gives every worker call its own `Receipt`, so rule 10's spend stays
derived from the record and a per-task cap still binds *between* passes —
`spendLimitsFor` is re-read per pass, and a cap or meter stop ends the
round instead of calling the worker again. The passes' receipts and
declared gate changes are carried into `recordRoundResult` as
`roundReceipts`/`roundGateDeclarations`, so the delivery accounts for
all of them and not just the last, and all of them land on this round's
own `"delivered"` event.

**What `baseCommit` means from then on.** After a successful rebase,
origin's tip *is* the branch's fork point, so that is what the round's
delivery records and what `diffFiles` is pinned to — against the old base
the `files` list would name everything origin itself changed as this
task's work. An `already-current` round keeps the base it had (still an
ancestor of the branch), and a round that aborted its rebase puts the old
base back.

### Telling the Client a delivery is behind that base, before he rules

The rebase above answers "what will a `fix` do". `base-standing.ts`
answers the question that comes first, while a delivery is sitting there
waiting on a verdict: *is* this branch behind origin's default tip? Both
`fabrica status` and the live view mark one that is - "behind
origin/&lt;branch&gt;, a fix will rebase (origin last fetched Nm ago)" -
from `describeBaseStanding`, the one renderer, so the two surfaces cannot
word it differently.

Three properties, all of them deliberate:

- **It writes nothing, and it never fetches.** Four read-only git calls
  against local refs: `git symbolic-ref --short
  refs/remotes/origin/HEAD` for origin's default branch (never assumed
  to be "master"), `git rev-parse --verify` on
  `refs/remotes/origin/<base>` and `refs/heads/<branch>`, and `git
  merge-base --is-ancestor` between them - plus a `stat` on the path
  `git rev-parse --git-path FETCH_HEAD` names, for the freshness clause.
  `base-standing.test.ts` snapshots the whole project folder, `.git`
  included, around a call and asserts not one byte moved. Fetching would
  be the more accurate answer and was ruled out: this is a reporting
  surface read many times an hour, and it must not mutate the Client's
  repository (or wait on his network) to report. `src/line/cut.ts` and
  `rebase.ts` already fetch at the two moments that matter, so the mark
  is never staler than the work it describes - and it says how old that
  fetch was, rather than implying it is live.
- **Local `refs/remotes/origin/HEAD`, not `git ls-remote --symref`.**
  `cut.ts` asks the remote because it is about to cut a branch from the
  answer. The local symref is the same fact written down: verified on
  git 2.54.0 that `git clone` writes it and `git fetch origin` writes it
  when missing (it is left alone once set, so `git remote set-head origin
  -a` is the fix for a checkout whose remote default has since moved -
  which is what the "base unknown" wording points at).
- **A question it cannot answer is never answered anyway.** No origin
  remote, no `origin/HEAD`, a deleted branch, a project folder that has
  been moved away, a git that refused: each comes back as
  `base unknown: <reason>`, one line, shown verbatim. A silent fall back
  to "current" was explicitly ruled out - it would read as "your branch
  is fine" on exactly the repositories where nothing is known.

Only a *delivered* task is ever asked about: it is the one state where
`fix` is the Client's live option, so it is the only one where "a fix
will rebase" is information rather than trivia.

## Rule 10: spending caps (issue #11)

**Where cost comes from.** A brain reports what one `work()` call cost on
a transcript entry with kind `"usage"`, whose text is JSON
`{ "totalCostUsd": number | null, ... }` (documented on
`contract/surface.ts`'s `TranscriptEntry`). `attempts.ts` sums every
usage entry into the attempt's `Receipt.costUsd`. If any of them is
null or unreadable, or there is none at all, the cost is `null` and the
receipt carries `costUnknown: true`. Unknown is never counted as $0.

**Metered money and subscription estimates don't mix (issue #188).** The
same usage entry can carry `"costBasis": "metered" | "subscription-
estimate"` - omitted means "metered". A flat-rate subscription's own
tool (the reference adapter's flat-rate subscription account, see that
adapter's own doc file)
reports a real, computed dollar figure that never moves a bill; it
marks every usage entry `"subscription-estimate"` so the caps never
treat it as the real money rule 10 was written for. `costFromTranscript`
(`spend.ts`) returns `{ costUsd, costBasis }`; the basis lands on
`Receipt.costBasis` and on `spend.ts`'s `SpendTotals` (`{ meteredUsd,
subscriptionUsd }`, what `daySpend`/`taskSpend` return instead of a
single total). `requireRoomToStart` and `spendLimitsFor` read only
`meteredUsd` - a subscription estimate, however large, never refuses a
task or stops one mid-run on its own. `fabrica status` and the live view
still show it, separately and marked with a "~" (`describeTaskCost`'s
`formatKnownCost`), so the Client can see it without it ever binding a
cap. An unknown cost (no usage entry, or one that can't be parsed) still
blocks under any cap regardless of basis - there is no basis to know
yet, so this stays the conservative default it always was. A
hand-recorded cost (`fabrica cost`) is always metered: the owner is
vouching for a real figure.

**Where spend is counted from.** Only the record, read fresh every time
(`spend.ts`). Each attempt appends a `"receipt-recorded"` event the
moment it exists, so a task still running, or one that throws later,
still has its spend on the record. Receipts that only ever landed on a
`"delivered"` event (records written before issue #11) are counted too,
once per task and attempt. A restart, a second process, or a fresh
Foreman all get the same total.

**A crashed attempt leaves an UNMEASURED receipt (issue #167).** When
`brain.work()` throws - the model connection dropped mid-response, the
box died, the relay went away - the attempt still appends a
`"receipt-recorded"` event with `costUsd: null` and `costUnknown: true`,
outcome `"failed"`, before the error is rethrown
(`attempts.ts`' `catch` around the worker call; both callers already
wire `onReceipt` to `recordReceipt`). It used to append nothing at all,
so 18 minutes of billed worker time left the task's cost at its previous
value and the daily cap blind to the whole attempt. Three deliberate
details:

- **The cost is forced to null, not derived** from whatever usage
  entries arrived live before the crash. The figure a worker reports
  rides on an entry it only produces when it reaches the end of its own
  run, so a partial figure would be a *known* cost on the record for
  spend that is in fact unknown - understating it, and clearing a block
  it must not clear.
- **Only the worker's own call counts as spend that may have happened.**
  A failure in Fabrica's own code before `brain.work()` was ever reached
  - a missing check command, a line that could not be cut, a project
  that moved - records no receipt, because it spent nothing and an
  unmeasured receipt there would block every new task over money that
  never moved. That holds by construction: those failures happen outside
  `runAttempts` entirely (Client's clarification, 2026-10-23).
- **The receipt is spend, not progress.** `stateOf` ignores
  `"receipt-recorded"`, and the round still appends `"task-failed"` on
  its way out, so the task reads as failed with no delivery to rule on.

Clearing it is the ordinary path below - `fabrica cost <id> <usd>`, no
new mechanism. One sharp edge worth knowing: the ledger keys on `(task,
attempt)` and keeps the first receipt it sees for a pair, while
`runProductionRound` always numbers from attempt 1, so a crashed
answered round that is answered again leaves two receipts for attempt 1
and the unmeasured one wins. That is the safe direction (the block
persists until a real figure is recorded, and `recordCost` covers every
still-unknown attempt of the task at once) and is left as is: letting a
later known cost overwrite an earlier unknown one would clear a block
for spend nobody measured.

**"Daily" is a rolling 24 hours ending now, not a calendar day.** It
uses each receipt's `startedAt`. No clock or time zone decides when the
day ends, and there is no midnight at which a full day's budget comes
back at once. Spend ages out exactly 24 hours after it started.

**At the start of any spend** (`caps.ts`'s `requireRoomToStart`: a new
task right after it is registered and before `ask()`, a `fabrica answer`
resume before the answer is recorded, a `fix` verdict before it is
recorded), the task is refused when:

1. a cap is set and any attempt anywhere on the record has an unknown
   cost not yet recorded by hand. This holds however old the attempt
   is: it stays until its cost is recorded. The error names each
   unmeasured task and its `fabrica cost <id> <usd>` command
   (`spend-unknown`).
2. the last 24 hours' known spend is at or past `perDayUsd`
   (`cap-refused`, with both figures in the message).
3. this task's own spend, every round counted, is at or past
   `perTaskUsd` (relevant for a resume or a fix).

A refusal appends `"cap-refused"` to the refused task's own record, with
the same message, before it throws. A brand-new task refused this way is
`failed` and can never move again (a new `fabrica do` is a new task). A
refused resume or fix leaves the task as it was, so the same command
works once there is room.

**While a task runs**, the remaining per-task budget goes to the brain
as `BrainWorkOptions.maxSpendUsd`, a hint an adapter may honor mid-call.
The reference adapter passes it as `--max-budget-usd`. The guaranteed
stop is the check after every attempt: if a cap is set and the attempt's
cost is unknown, or the task's spend has reached `perTaskUsd`, no
further attempt starts. The task is then delivered as outcome
`"cap-stopped"`, which is distinguishable from `"failure-report"`: its
summary says the cap stopped it, with the numbers. The work so far is
still committed, Inspector is not called, and `"cap-stopped"` lands on
the record. The one exception is work that already finished green on
its own terms (an early green, or the last attempt green). Nothing was
cut short there, so it delivers normally. Its receipts still show the
real cost, and when that cost is unknown under a cap, its `gaps` says
new work is blocked.

**One attempt can overshoot `perTaskUsd`.** The between-attempts check
cannot interrupt a call already in flight. An adapter that ignores
`maxSpendUsd` therefore spends whatever its one attempt costs. Even the
reference adapter's CLI checks its budget only after each turn: one
turn cost $0.14 against a $0.0001 budget when verified on 2.1.295.

**Clearing an unknown cost.** `recordCost(taskId, usd)` (`fabrica cost
<taskId> <usd>`, owner-only) appends `"cost-recorded"` with the figure
and the attempt numbers it covers, which are exactly the ones still
unknown at that moment. A later attempt with an unknown cost is unknown
again until it is recorded too. It refuses a figure that is not a finite
amount of zero or more, and refuses a task with nothing unmeasured. That
way a block only clears when a real cost is recorded, and the same spend
is never counted twice.

**The clarifying step's cost counts too.** `ask()` reports what its one
call cost (`BrainAskResult.costUsd`), and the Foreman records it as
`"ask-cost-recorded"` (`{ costUsd, startedAt }`). The ledger counts it like
an attempt's spend - in the day's total and the task's own - as attempt 0
inside `spend.ts` only (it is never a Receipt). A null or missing cost is
unknown, never zero: under a cap it blocks new work, named "the clarifying
step", until `fabrica cost` records it.

**A quiz re-check's cost counts too, the same way.** `src/quiz/`'s
re-check round (see that module's README) is a worker call, so it reports
what it spent, and the round records it as
`"quiz-recheck-cost-recorded"` (`{ costUsd, costBasis, startedAt }`)
against the task whose questions it re-checked. The ledger counts it like
the clarifying step's: its own attempt slot inside `spend.ts` only, never
a Receipt, so it moves no attempt numbering. It counts **backwards** -
`QUIZ_RECHECK_FIRST_STEP = -1`, and the nth re-check of one task is `-n` -
because later work can keep touching a task's files, so one task can be
re-checked more than once and each round is its own spend. `fabrica
status`'s unmeasured block names it "a quiz re-check" rather than
printing an invented negative attempt number. The re-check itself tests
for room read-only (`recheckRoomProblem`) rather than calling
`requireRoomToStart`, which would append a `cap-refused` event to an
already-closed task that never attempted a start.

## The pause rule: the subscription meters (issue #189)

Rule 10's caps are dollars. The pause rule is the Client's flat-rate
**subscription windows**, which cost nothing to fill - so no dollar cap
can ever notice them, and a task can run a whole week's quota down
without a single cent of metered spend appearing anywhere. Hence a
second rule, deliberately beside `caps.ts` rather than inside it, with
its own config table, its own events, and its own outcome.

`src/foreman/meters.ts` owns the semantics; `[pause]` in projects.toml
owns the numbers (`src/config/types.ts`'s `PauseRule`). Every threshold
has a default, because unlike the caps - which do nothing until the
Client sets one - this rule is always on:

| Threshold | Default | What it does |
| --- | --- | --- |
| `sevenDayRefusePercent` | 70 | Above this much of the 7-day window used, no new task, resumed round or fix round starts. |
| `sevenDayStopPercent` | 90 | Above this, an attempt already in flight is stopped gracefully. |
| `fiveHourRefusePercent` | 90 | Above this, no new work starts. |

The 5-hour window deliberately has **no** stop threshold: it refills
within hours, so throwing away an attempt's work for it would cost more
than it saves (Client's clarification). A stop threshold below its own
refuse threshold is refused at config load - it could only be a
mistake.

**Where the numbers come from.** Not from the worker CLI's own output:
that carries neither number, which was established by running it rather
than assumed (see
`notes/20261020-do-fabrica-issue-189-as-written-closing-i3.md`). They
come from the provider's HTTP response headers, which the host-side
relay already sees on every forwarded call
(`src/relay/README.md`'s "Watching a response header"), and reach the
Foreman through `src/brain/meters.ts` - a workdir-keyed side channel,
the same mechanism and reasoning as `live-transcript.ts` and
`relay-health.ts`, so nothing is added to `Brain`'s ratified signature
and nothing outside `src/brain/adapters/` has to know a provider's
header names (rule 8).

**Two rules the whole thing follows.**

- **Fail open, but never fail quiet.** A reading that is missing,
  unreadable, carries neither meter, or is older than
  `METER_READING_MAX_AGE_MS` (one hour) is *unknown*: nothing is
  refused, and a line on stderr says so. Never refuse work on a number
  nobody could read (Client's clarification). An hour is deliberately a
  much shorter span than either window it talks about - it is "how long
  ago did we last look", not "how long until the quota resets" - and a
  reading that old is better replaced than trusted, which the next
  attempt does for free.
- **A pause is never a failure.** An attempt a meter stops gets its own
  receipt outcome, `"paused-by-meter"`, and its own delivery outcome of
  the same name - never `"failed"`, never `"inspection-red"`. Nothing
  resumes by itself: the task waits on the Client's own `fix` verdict,
  exactly as a cap-stopped one does, and `fabrica status` names the
  pause right on its line.

**How the stop actually happens.** `attempts.ts` reads the meters on
the heartbeat tick it already runs (`readAndJudgeMeters`) - so a
reading that arrives mid-attempt stops it mid-attempt, roughly one
heartbeat interval later, rather than only at the attempt's boundary.
The decision is recorded first and acted on second: `pauseWorker` asks
the adapter to stop its own box *gracefully* - SIGTERM, then SIGKILL
after a grace period
(`src/containment/`'s `gracefulStopSignal`/`GRACEFUL_STOP_SECONDS`),
the same two-signal shape `src/cli/task-process.ts` uses for the
Client's own stop - and the `work()` call then ends by itself.
Whatever the worker had done is committed with a fallback message (it
has no write-up: it never reached the end of its own work), so it
survives the ProductionLine's teardown for the fix round the Client may
ask for, and is never handed to a check or to Inspector. A worker with
nothing registered to stop runs to its own end and the pause applies at
that boundary instead - which the record says, through
`workerStopped: false`, rather than claiming a stop that never
happened.

**Where it lands on the record.** `"meter-refused"` for a start that
never happened (the counterpart of rule 10's `"cap-refused"`),
`"meter-paused"` for a round stopped in flight (the counterpart of
`"cap-stopped"`), and - the ratified half of the issue - both meters on
**every** receipt, as `Receipt.meters`, or `null` where nobody could
say. Null is never 0: an unreported quota and an empty one are opposite
facts. `latestMeterReading` reads those receipts back, newest by the
reading's own `observedAt` rather than by position in the log, since
two tasks running at once append their receipts in the order their
attempts *end*.

## The pull request's own checks are part of the round (issue #267)

Inspector's green is no longer the last word. Everything the repository
runs on the pull request *after* Inspector has published — the
protected-path gate, a formatter, a container rehearsal, `docker-tests` —
used to be invisible here: nothing landed on the record when one went
red, the worker never heard about it, and `status`/`watch`/the live view
read "delivered" while the pull request page read red.

`judge.ts`'s `inspectorJudge` now reads them, at exactly one point: right
after `handToInspector` returns a **green** verdict that carried a
`prUrl`. A red or refused inspection published nothing, so there is no
pull request whose checks could say anything about that attempt; neither
has a green run that opened none. The read itself is `src/ci/`
(read-only, GET requests to GitHub's REST API, and nothing executed
anywhere — issue #64's ruling is untouched); the record writing is
`ci-checks.ts`'s `handToPullRequestChecks`, here, for the same reason
`inspection.ts` rather than the `Inspector` adapter records Inspector's
own call: a test fakes the outside call, and cannot fake the recording.

A red read flips that attempt's gate to red, carrying the checks' own
output (every red check by name, its link, and the tail of its job log),
and sets `Judgement.ciRed` to the one-phrase summary. From there nothing
downstream needed changing: `roundOutcome` yields `inspection-red`,
`buildDelivery` puts it on the attempt's receipt and points
`evidence` at it, `attempts.ts`'s
`correctionBrief` hands it to the next counted attempt, and
`deliveredState` puts the task in front of the Client. `ciRed` exists so
the delivery's *wording* can be honest — Inspector said green, and a
summary blaming it would send the Client to the wrong log — and it is
read off the judgement in `round.ts` exactly the way `writeupInvalid`
already is, so no new field crosses `AttemptLoopResult`.

A `fix` round on such a delivery gets the checks' output alongside the
Client's note (`queries.ts`'s `redPublishedChecksOf`, reading the
round's own last judged receipt → `src/ci/report.ts`'s
`checksCorrection`), the same shape
`refusalCorrection` already has. Unlike a refusal, it does **not** unwrap
`skipIfUnchanged`: the branch really was reviewed and published here, so
a round whose worker changes nothing has nothing new for anybody, and
re-reading the same commit's checks could only find the same red.

Three results deliberately leave the round alone: an `unknown` (the
bounded wait expired with checks still running), a `none` (the repository
reports no checks), and an `unreadable` (the API could not be read). Each
is recorded as itself and named in the delivery's own evidence — never
silently dropped, and never turned into a red. Inventing a red out of a
silence is the same lie as calling it green. See `src/ci/README.md` for
the verdict table, the three bounds, and the GitHub-side sharp edges.

## Files

| File | Holds |
| --- | --- |
| `errors.ts` | `ForemanError`, with codes `no-brain`, `invalid-attempts`, `missing-check`, `commit-failed`, `unknown-task`, `not-delivered`, `inspection-refused`, `already-closed`, `invalid-verdict`, `missing-note`, `no-questions-pending`, `already-answered`, `missing-answer`, rule 10's `cap-refused`, `spend-unknown`, `invalid-cost`, `nothing-to-record`, issue #189's `meter-refused` (a subscription meter past its refuse threshold - not a dollar cap), `not-running` (issue #203: `stop` on a task that is not running), issue #199's `model-call-failed` (a model call was dropped in transit, retried once on the same model, and dropped again - see "A dropped model call is retried once" above), and `inspector-not-ready` (Inspector mode with no GitHub token - see `src/inspector/README.md`), `reviewer-not-ready` (no model could be settled to judge a project that asks for its test changes judged - see `src/reviewer/README.md`), `knowledge-unavailable` (a project's named knowledge-base notes could not be carried into the brief - see "The knowledge-base notes a project names" above), and `project-not-a-repo`. |
| `judge.ts` | Who judges each attempt (issue #64): Inspector, or a self-test in the Worker's box. `prepareRound` picks the mode, and - only for a task that will actually be inspected - settles who reviews its test changes (`reviewer.ts`'s `requireReviewer`, refusing with `reviewer-not-ready` before Inspector is called at all); `roundOutcome` turns the last judgement into a delivery outcome. `Judge` is handed each attempt's resolved `finalMessage` (pr-body.ts) alongside `gateChanges`, so `inspectorJudge`'s own per-attempt commit and Inspector's pull request always carry the same title/body `attempts.ts` computed - `attempts.ts` only calls `judge()` once that message is valid, so this commit and that pull request are only ever made with a valid write-up as their message. Nothing here runs a check on the host - `no-host-check.test.ts` fails if anything under `src/foreman` spawns anything but `git`. `skipIfUnchanged(judge, workdir, priorHead)` wraps any `Judge` so an attempt that leaves `workdir`'s HEAD exactly at `priorHead` never reaches the real judge at all - returns `Judgement.unchanged` instead - `verdict.ts`'s `runFixRound` is the one caller, `priorHead` being the branch's HEAD the moment that round's line was reopened. |
| `pr-body.ts` | `writeupProblem`/`finalMessageFor`/`renderCommitMessage`: checks a worker's structured write-up (`BrainWorkResult.writeup` - title at most 60 characters, seven other non-empty required string fields, a `confidence` number from 0 to 100, a `quiz` of exactly three answered questions, and the one optional `couldNotVerify`; issues #185/#194/#98, Client ruling 2026-10-18) and renders it as the commit message and (when Inspector is configured) the pull request title and body - the Client's own template, five sections to the heading: `## Context (Why)`, `## Description (What)`, `## Changes in the codebase (How)` and `## Changes outside the codebase` each holding one field verbatim, then `## Additional information` folding confidence/assumptions/expectedOutcomes/deviations/couldNotVerify into labelled bullets in that fixed order, a bullet with nothing in it omitted entirely rather than rendered as a placeholder - or, when it is missing or invalid, a fallback naming what is wrong, never the task's own words. Nothing is parsed out of the worker's prose. The `quiz` is the one required field this does NOT render: it is validated here and shown to the owner on the live view (`/review` and `/quiz`, issue #98), never in the pull request body, whose layout is the Client's own ratified template. Each of those five headings (`TEMPLATE_HEADINGS`) is Fabrica's own to emit and appears in a rendered body exactly once: a worker that echoes a heading into one of its own fields - the one way a real pull request ended up reading `## Additional information` twice in a row, since no code path here has ever emitted it more than once - has that heading-only line dropped as the field renders (`withoutTemplateHeadings`), keeping every word around it, where refusing the write-up outright would cost a red round for a cosmetic slip. A heading inside a fenced code block is kept exactly as written: a write-up quoting this template is showing a heading, not emitting one. Also `closesIssueFor`/`issueNamedByTaskText`/`withClosesLine`: whether this task's pull request should close an issue on merge - only when the task is the *whole* of that issue's work, from `taskText` opening with "Issue #N:" or from an `issue` number the chat agent named explicitly (`Foreman.do`'s `opts.issue`, persisted once at registration by `ask.ts`) - prepended as the pull request **body**'s first line by `judge.ts`'s `inspectorJudge`, never put on the commit message. |
| `resolve-check.ts` | Picks the check command: a registered project's `check`, or the `check.sh` convention; `requireCheckCommand` refuses a self-tested task with none. |
| `reviewer.ts` | The round's half of the reviewer seam (`src/reviewer/README.md`): `requireReviewer` settles who judges this project's test changes, reading `testPaths` from `.inspector.json` **at the task's base commit** - never the worktree a Worker has touched, so a Worker cannot change who reviews its own work. Refuses with `ForemanError("reviewer-not-ready")` on the same three grounds `fabrica do` already printed up front, so a resumed round, a fix round, and a library caller stop too. Resolved here rather than once in `createForeman`, which also runs for `status`/`log`/the live view, none of which call Inspector. |
| `registered-project.ts` | `registeredProject(recordHome, projectPath)` - which `projects.toml` entry, if any, is this project, both sides resolved through `realpath`. Shared by `network-policy.ts` and `touched-tests.ts`; a malformed registry reads as "unregistered" here, since `resolve-check.ts` runs first in every round and is the right place for that error to surface loudly. |
| `touched-tests.ts` | Issue #142's "run only the tests you touched": `onlyTouchedTestsFor` (the project's `onlyTouchedTests` setting, unless this task's own words ask for the full suite) and `workerBrief`, the one function every round calls to build the brief a Worker actually receives. See the section above. |
| `task-knowledge.ts` | The knowledge-base notes a project names in `projects.toml` (`src/knowledge/`): `knowledgeNotesFor` reads them off the disk - run by `ask.ts`/`do.ts`/`verdict.ts` before any ProductionLine is cut or reopened, so a missing knowledge base or note refuses with `ForemanError("knowledge-unavailable")` naming which - and `withKnowledge` appends them to a brief, idempotently, refusing rather than trimming when the brief would pass `MAX_BRIEF_BYTES`. See the section above. |
| `network-policy.ts` | `networkPolicyFor(recordHome, taskId, projectPath)` - the hosts and relay limits a project declared in `projects.toml` (issue #186), matched to the project the same way `resolve-check.ts` matches its check, through `registered-project.ts`. `ask.ts`, `do.ts` and `verdict.ts` each wrap their `brain.ask`/`brain.work` call in the result (`src/brain/task-network.ts`), which is how a refused host reaches *this* task's record instead of nowhere; an unregistered project declares nothing, which means the adapter's own base hosts and the relay's default limits, never "nothing allowed". |
| `attempts.ts` | The counted retry loop; builds each correction brief from the previous check's failure output. Commits every attempt the moment `work()` returns, with the worker's write-up as the message (`pr-body.ts`), or a fallback naming what is wrong. A missing or invalid write-up makes the attempt red on that alone (`write-up invalid: <reason>`, set as `Judgement.writeupInvalid`) without calling `judge()`, so it is never handed to Inspector; that fallback commit is unpublished, and the next attempt amends it - new changes and message together, or only the message - rather than stacking another. The next attempt's correction brief quotes the reason back; a round that ends on it delivers as `failure-report`, never `inspection-red` (`judge.ts`'s `roundOutcome`). Returns the last attempt's resolved message as `finalMessage`, which `do.ts`/`verdict.ts` use for their pre-teardown commit should anything be left uncommitted. `initialSession`/`startAttempt` (verdict's fix path) resume a session and continue attempt numbering instead of starting cold at 1. `gateForRecord` caps how much check output anything stored in the record keeps - a receipt's `checks`, which is where it lives, and the excerpt `delivery.ts`'s `checkEvidence` shows of it. Also ticks `onHeartbeat` every `DEFAULT_HEARTBEAT_INTERVAL_MS` while a `brain.work` call is in flight, so a long opaque await still shows up on the record (issue #12) - and asks on the same tick whether that box's own network relay is still there (`src/brain/relay-health.ts`), failing the attempt with `ForemanError("worker-network-gone")` when it isn't, rather than waiting minutes for the worker to notice (see "A worker whose network is gone fails now" above) - `do.ts` and `verdict.ts` both wire it to a `"heartbeat"` event - and fires `onCheckStarted` right before the check runs, so `"check-run"` lands twice per attempt (`details.phase: "started"`, then the result-carrying one) and a task genuinely mid-check is distinguishable from one that already finished a check (`queries.ts`'s `stateOf`). `onTranscriptEntry` fires once per transcript entry, live, the moment a streaming-capable brain reports it through `src/brain/live-transcript.ts`'s workdir-keyed listener registry (issue #70) - registered before `brain.work()` is called and unregistered once it settles; any entry `workResult.transcript` carries that never arrived that way (every entry, for a brain with no finer-grained signal than "the whole call just finished") is delivered right after, from the return value's remainder - so every entry reaches `onTranscriptEntry` exactly once, in order, whether or not the brain streams. `do.ts`/`verdict.ts` wire it straight to an `appendTaskFile` call per entry. `onTransportRetry` fires when a `brain.work()` call was dropped in transit and is about to be made once more on the same model (issue #199, `transport-retry.ts`) - inside the same turn of this loop, so the attempt counter never moves. |
| `transport-retry.ts` | Issue #199: `transportFailureReason` (is this a call that never arrived, or an answer that said no?) and `withTransportRetry` (one retry, on the same model, after a short wait, then an honest `ForemanError("model-call-failed")` naming the model and both failures). Used by `attempts.ts` around every `brain.work()` call and by `ask.ts` around `brain.ask()`; a retry is recorded as `"transport-retry"` and is never an attempt. See "A dropped model call is retried once, and never swapped" above - including why the classifier is an allowlist and why a `ForemanError` is never retried. |
| `commit.ts` | Commits whatever a Worker left in the worktree onto the ProductionLine's branch, before teardown - unconditionally; it already asks the index directly and no-ops when nothing is staged. Runs for every outcome, declared or undeclared gate change included - see "Rule 9: blocked by CI, not by Fabrica, and not watched by Fabrica either" above. |
| `delivery.ts` | Builds the `Delivery` object and its `delivery.md` rendering, plus `buildCommitFailureDelivery` for the one path that isn't a normal outcome - the pre-teardown commit itself failing - and `buildNothingChangedDelivery` for a fix round `judge.ts`'s `skipIfUnchanged` caught before it ever reached a check or Inspector. Its `evidence` for a check that reached a verdict is `checkEvidence`: a pointer to the attempt whose receipt holds the output, plus that output's first/last few lines, run through `attempts.ts`'s `gateForRecord` first so even the excerpt is byte-capped like a stored receipt (issue #68 - the receipt is the source; a caller that cannot name the attempt gets the capped output itself, as before). `deliveredState` treats `"nothing-changed"` as `"delivered"`, same as `"done"`/`"inspection-red"`/`"not-verified"` - and `"paused-by-meter"` (issue #189) too, since a paused round waits on the Client's own `fix` verdict and is explicitly never a failure. `buildPausedByMeterDelivery` builds that report. |
| `round.ts` | `recordRoundResult` (issue #182) - the one place "judge the work, commit it, decide the outcome, hand over the delivery, write the record" is written: everything a round does once `runAttempts` resolves - the refused check, the fix-only "nothing changed" short-circuit, the pre-teardown commit (and its own failure-report path), building/validating the `Delivery`, and writing `delivery.md` plus the `"delivered"` event. `do.ts`'s `productionRound` and `verdict.ts`'s `runFixRound` both call this with the same `AttemptLoopResult` shape and differ only in what they pass as `ctx` - a pinned vs. freshly-cut `baseCommit`, and (fix only) `priorReceipts`/`priorGateDeclarations` (the task's earlier rounds, read back off the record) plus `roundReceipts`/`roundGateDeclarations` (this round's own earlier passes). Writes each round's receipts and gate declarations on that round's event alone, with the task's cumulative attempt count as `attemptsSoFar` (issue #68), and names the attempt whose receipt holds the check output so the delivery's `evidence` can point at it instead of copying it. Everything before this point (reopen vs. create the ProductionLine, the attempt budget, the `work-started` event, `runAttempts` itself) stays in each caller, since that's exactly where the two round-starters still differ. |
| `gate-declarations.ts` | Rule 9's declarations across a task's rounds (issue #68): `gateNamesIn` finds the gates a worker's own prose names, and `mergeGateDeclarations` folds every round's declaration into the one text the delivery reports - newest per gate, so the text is bounded by the gates named rather than growing one block per round. Written to fail safe: a gate name it misreads can only ever keep an older declaration standing beside a newer one, never drop one, and rule 9's enforcement does not read this at all. |
| `inspection.ts` | Records the configured Inspector handoff and its green, red, or refused result. A refusal reaches the record and task status but never becomes a red delivery. |
| `ci-checks.ts` | Issue #267: records what the repository's own checks said about the pull request Inspector opened or updated - one `"ci-check-concluded"` per concluded check (name, conclusion, log URL, and the tail of its job log when red), then one `"ci-checks-finished"` summary carrying the phrase every task line shows and the checks that never concluded. `ChecksReader` is the seam the GitHub read sits behind (`src/ci/`'s `readPullRequestChecks` by default, a fake in tests, threaded from `createForeman`'s `checksReader` option the same way `inspector`/`checkBox` are); the record writing is here so no fake can skip it, exactly as with `inspection.ts`. Reads nothing itself and executes nothing - see "The pull request's own checks are part of the round" above. |
| `ask.ts` | `registerAndAsk` (issue #8) — register the task, then `brain.ask()`'s first pass; records `"questions-asked"` when materially ambiguous, `"ask-failed"` (then rethrows) when the call itself throws. See "The ask-first seam" above. |
| `do.ts` | `doTask` (registers, asks-or-proceeds) and `runProductionRound` (isolate/work/verify/inspect/result, shared with `answer.ts`'s resume path) - its tail, once a round's attempts are done, is `round.ts`'s `recordRoundResult`. |
| `answer.ts` | `answerTask` (issue #8) — resumes a task that stopped for questions: appends the round, re-derives `brief.md`, calls `runProductionRound`. See "The ask-first seam" above. Split in two (issue #123) so `src/cli/answer-command.ts` can detach the round: `recordAnswerDecision` (validate + record, no round) and `runRecordedAnswer` (re-derives the brief/ctx from the record and calls `runProductionRound`) - `answerTask` composes both, unchanged for every other caller. |
| `verdict.ts` | `recordVerdict` — rule 6, described above: closes on accept/wrong (wrong alone also closes a task Inspector refused with no delivery, via `queries.ts`'s `refusedWithNoDelivery`, or a task that failed before any delivery, via `failedWithNoDelivery`; accept and wrong both still rule on an earlier real delivery a later fix round's refusal supersedes, recording `supersedesRefusal: true`), re-enters the same line and worker on fix - including on a task whose latest word IS such a refusal (`queries.ts`'s `refusalAfterDelivery`), where the round's brief carries Inspector's own reason as a correction (`refusalCorrection`) and `"verdict-recorded"` notes `answersRefusal: true`. Split in two for its `fix` path (issue #123) so `src/cli/verdict-command.ts` can detach the round: `recordVerdictDecision` (validate + record, no round) and `runRecordedFix` (re-derives project/baseCommit/prior receipts/the note from the record and calls the module-private `runFixRound`) - `recordVerdict` composes both, unchanged for every other caller. `runFixRound` captures the branch's HEAD before the round's one attempt runs and wraps its judge with `judge.ts`'s `skipIfUnchanged`, so a round that lands no new commit delivers `"nothing-changed"` (`delivery.ts`'s `buildNothingChangedDelivery`) without ever calling Inspector or a self-test check - unless rule 10's cap already stopped the same round, which still wins, or the round is answering a refusal (nothing was reviewed, so the unchanged commit is handed over again rather than skipped); its tail, same as `do.ts`'s, is `round.ts`'s `recordRoundResult`. |
| `stop.ts` | `recordStopDecision` (issue #203) - the record half of the Client stopping a task himself from the review page: refuses a task that is not `"working"`/`"checking"` (`not-running`, naming the state), otherwise appends `"stopped-by-owner"` carrying who stopped it (the Tailscale login), which state it was stopped from, and the worker's last transcript line with its timestamp. Signaling the process is deliberately NOT here - that needs `ps`, and `no-host-check.test.ts` fails if anything under `src/foreman` spawns anything but `git`; `src/cli/task-process.ts` owns it, and `integrations/live-view/server.ts` composes the two the same way `src/cli/` composes `recordVerdictDecision` with `spawnDetachedResume`. |
| `queries.ts` | `deliveryOf`, `receiptsOf`/`reconstructReceipts`, `gateDeclarationsOf`, `eventsOf`, `statusOf`, `latestDeliveredDetails`, `eventsByTask`, `stateOf`, `refusedWithNoDelivery`, `refusalAfterDelivery`, `redPublishedChecksOf`, `failedWithNoDelivery`, `earlyStopKindOf` - all read from `events.jsonl`. `deliveryOf` suppresses an older delivery after a newer Inspector refusal. `receiptsOf` reconstructs the task's whole receipt list from every event carrying one, keyed by attempt with the latest restatement winning, and `gateDeclarationsOf` does the same for rule 9's per-round declarations - both tolerate a record written before issue #68, when each event carried the cumulative view instead. `refusedWithNoDelivery` is narrower than that: true only when there is no `"delivered"` event at all and the latest `"inspection-finished"` is a refusal - `verdict.ts`'s one carve-out letting `wrong` close such a task. `refusalAfterDelivery` is its exact other side: the latest `"inspection-finished"` is a refusal, it is newer than the task's last `"delivered"` event, and there IS one - the state a `fix` verdict re-enters the worker for, carrying that refusal's own report as the correction. `failedWithNoDelivery` (issue #143) is the sibling carve-out for a task that never reached a delivery because it failed first - `stateOf` reads `"failed"` and no `"delivered"` event exists anywhere in its history. `earlyStopKindOf` names *why*, in words, for whichever of those two applies (Inspector's own report, or whichever of `"cap-refused"`/`"task-failed"`/`"ask-failed"` actually killed the task) - the one function `fabrica status` and the phone review page (`integrations/live-view/record-view.ts`'s `getReviewRows`) both call, so a task waiting on a `wrong` verdict for either reason can never read differently on the two surfaces. `fixRoundOf` counts *every* `"verdict-recorded"` event with `ruling: "fix"`, since every round matters, not just the latest. `eventsByTask` groups the whole log in one pass and `stateOf` derives a state from events already in hand, so a reader like `fabrica status` doesn't re-read the log per task. `stateOf` has two absorbing states rather than pure "last event wins": `"stopped"` (issue #203) and a recorded failure, which only `CLEARS_FAILURE`'s three event names take a task back out of - see "A recorded failure is absorbing too" above. |
| `transcript.ts` | Read side of a task's `transcript.log` (`readTranscript`) for `fabrica log --transcript`; skips a half-written line rather than throwing, since it reads a file still being appended to. |
| `follow.ts` | `followTask` — the same two files (`transcript.log` and this task's slice of `events.jsonl`) read *incrementally* for `fabrica watch`, over `src/record/tail.ts`'s byte-offset line reader. A one-shot reader can afford to re-read its whole file; a 2Hz poll can't, on a log that holds every task the record home has ever seen and grows by a heartbeat per running task per 15s. Each `read()` still returns the task's full history — `stateOf` and the quiet/terminal notices all derive from the whole list — it just parses only what landed since the last call, and hands back fresh arrays each time (rule 5). |
| `spend.ts` | Rule 10's ledger, derived from the record: `costFromTranscript` (now `{ costUsd, costBasis }`), `daySpend`/`taskSpend` (rolling 24 hours, returning `SpendTotals` - metered vs. subscription-estimate, issue #188), `unmeasuredSpend`, and the shared wording (`formatUsd`, `describeTaskCost`, `SPEND_UNKNOWN_LINE`). |
| `caps.ts` | Rule 10's enforcement: `requireRoomToStart`, the per-round `spendLimitsFor`, the `"receipt-recorded"`/`"cap-stopped"` writers, and `recordCost`. See "Rule 10: spending caps" above. |
| `model.ts` | Issue #184's model facts: `resolveModelChoice` (the flag beats the project's setting beats nothing), `writeModelChoice`/`readModelChoice` (the `model.json` task file), `modelFromTranscript` (the brain's own report for one call), `receiptModel` (the only builder of a receipt's `model`, and the reason "default" can never appear in one again), `modelFromEvents` (what a task row can say, from events the caller already holds) and the shared wording `describeModel`/`describeDeclaration`. See "Which model ran" above. |
| `meters.ts` | Issue #189's pause rule: `pauseRuleFor` (projects.toml's `[pause]`, defaults when there is no file), `standingOf`/`refusalFor`/`stopFor` (the three decisions), `meterReadingFromTranscript` and `latestMeterReading` (the two ways a reading is read back - an attempt's own, and the record's newest), `requireMeterRoomToStart` (the start gate, called beside `requireRoomToStart` at all three of its sites), `recordMeterPause`/`meterPauseOf`, and the shared wording (`describeMeters`, `formatPercent`, `pauseMessage`) that `fabrica status` and the phone review page both show. See "The pause rule" above. |
| `task-failure.ts` | #73: `recordingFailure` appends `"task-failed"` (with the message) for any error after `task-received` and before a delivery or refusal - except one already on the record as `ask-failed` or `cap-refused`. `requireGitRoot` refuses a project path that is missing or not a git root before the clarifying step spends anything. |
| `standing-question.ts` | CONTRACT rule 11: `withStandingQuestion` puts the standing question, then the write-up notice (the structured write-up every worker must return), then the same-shape notice (a fix lists every other place in the code with the same shape, in the write-up, fixed or not - issue #147), then the durable-notes notice (a durable project fact goes in `notes/`, one file per task, never appended straight into the project's root agent-memory file's shared body - the merge-conflict fix that file documents) - all stated here rather than left to a file a worker might not read - at the start of every brief, applied by `touched-tests.ts`'s `workerBrief` once per round and again where `attempts.ts` hands its correction brief over, never twice. Also `ONLY_TOUCHED_TESTS_NOTICE` (issue #142), which unlike those four is conditional - `withStandingQuestion`'s `onlyTouchedTests` option adds it after the fixed prefix, and `touched-tests.ts` decides it. Only `STANDING_QUESTION` itself is ratified text (`contract/rule11.standing-question.test.ts` holds a verbatim copy); a new standing line is added as its own exported constant folded into `STANDING_PREFIX`, never appended to that question, so it needs no change to a protected contract path. |
| `foreman.ts` | `createForeman` — assembles the above into the `Foreman` shape, including the per-instance task→brain memory `verdict()`'s fix path and `answer()` both use. |

`GateResult`, `Delivery`, `FabricaTask`, `BrainAskResult`, and
`Foreman` itself are declared once, in `contract/surface.ts`, and
imported into this module's files as types (issue #45) — there is no
local `types.ts` here to keep in sync by hand any more. `Receipt`,
`Delivery` and `FabricaTask` are imported from `src/inspector/types.ts`
rather than straight from the contract: that file is the one place
Fabrica's own additions to a ratified shape live, and `Receipt` gained
two of them in issue #189 (`meters`, and the `"paused-by-meter"`
outcome) and two more in issue #184 (`declaredModel`, `modelSource` -
see "Which model ran" below).

## Which model ran (issue #184)

Every receipt used to say `model: "default"`. It was the reference
worker's own label for "whatever my configuration resolves to", and it
made the record unable to answer the one question a dashboard column
most wanted to ask. Three facts now, all on the receipt:

- `model` - the model that **actually ran**, as the worker reported it
  for that call. `model.ts`'s `receiptModel` is the only builder of this
  field anywhere, and it treats `"default"`/`"unset"`/`""` as
  placeholders rather than model names: a brain that offers nothing
  better yields `"unknown"`, never a word that reads like a choice
  nobody made. `model.test.ts` proves exactly that.
- `declaredModel` - what was **asked for** (`fabrica do --model`, or the
  project's own `model` in `projects.toml`), or `null`.
- `modelSource` - `"flag"`, `"project"` or `"default"`.

The actual model arrives from the brain as a reserved transcript entry
(`src/brain/model.ts`'s `MODEL_TRANSCRIPT_KIND`), read back by
`model.ts`'s `modelFromTranscript` - the same mechanism rule 10's
`"usage"` entry and issue #189's `"meters"` entry already use, for the
same two reasons: `Brain.work()`'s ratified return shape has no field
for it, and a per-call fact must never be mutable state on a `Brain`
object two concurrent tasks in one process share.

The declared half is resolved **once**, at registration
(`ask.ts`), and persisted as the task file `model.json` - exactly how
`issue` and `caps.json` are handled, and for the same reason: every
later round (a resumed one, a fix) re-derives it from the record rather
than from a `projects.toml` that may have changed under it, and that is
also what lets the detached entry points build their worker with the
right model from `recordHome` plus `taskId` alone. The declaration also
rides on `"work-started"`'s own details, beside `project`, so a task row
can name it from the moment work begins instead of waiting for the first
receipt.

`model.ts`'s `describeModel` is the one wording for all of it - "big-9",
"small-5 (declared via --model)", "big-9 (declared small-5 via
projects.toml)", "not reported yet" - shared by `fabrica status`,
`fabrica log` and the live view's own row, so the three can never word
the same fact differently.
