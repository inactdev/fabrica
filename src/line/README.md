# ProductionLine

A ProductionLine is a throwaway copy of your project, checked out on its
own branch, where one task's work and its checks happen. It exists so
your real checkout is never touched - not a stray file, not an index
change, not a stash - which is CONTRACT rule 1, the rule whose failure
damages your actual work instead of a copy.

## `createProductionLine({ project, taskId, recordHome })`

Creates the throwaway copy: a git *worktree* linked to `project`,
checked out on a fresh branch named `fabrica/<taskId>`. A worktree is
git's own mechanism for a second working directory that shares one
repository's history with the first - no clone time.

A new task's branch is cut from `origin`'s default branch, never from
whatever `project`'s local checkout happens to have checked out:
`createProductionLine` first runs `git fetch origin`, then reads the
remote's own default branch via `git ls-remote --symref origin HEAD`
(never assumed to be "master" - a project's default branch may be
"main", or anything else). The worktree is created from
`origin/<that branch>` with `--no-track` (a one-off task branch has no
business tracking origin's default branch for push/pull, and skipping it
avoids a config-file write/lock two concurrent creates from the same
project could otherwise collide over). Either step failing - no "origin"
remote, an unreachable one, a remote with no readable HEAD symref -
throws `LineError("fetch-failed")` *before* the task's working folder is
created at all; it never falls back to the local checkout. This matters
because the Client's own checkout can be on any branch, or any number of
commits behind origin, at the moment a task starts - two tasks started
from the same clone must still get the same base, not whichever commit
happened to be checked out when each one ran.

The workdir always lands at `<recordHome>/tasks/<taskId>/worktree`. The
branch is named `fabrica/<taskId>` rather than something free-form for
two reasons: every task's branch sits under one `fabrica/` namespace, so
`git branch --list 'fabrica/*'` finds all of them at a glance, and the
id ties the branch back to that exact task's own record on disk
(`<recordHome>/tasks/<taskId>/`) one-to-one.

```
createProductionLine({
  project: "/Users/ari/inkling-umbrella/spending-app",
  taskId: "20260804-fix-flaky-test-4f",
  recordHome: "/Users/ari/.fabrica",
})
```

returns a `ProductionLine`:

```
{
  taskId: "20260804-fix-flaky-test-4f",
  branch: "fabrica/20260804-fix-flaky-test-4f",
  project: "/Users/ari/inkling-umbrella/spending-app",
  workdir: "/Users/ari/.fabrica/tasks/20260804-fix-flaky-test-4f/worktree",
  recordHome: "/Users/ari/.fabrica",
}
```

Everything a Worker or a check does for this task should happen inside
`workdir` and nowhere else.

## `reopenProductionLine({ project, taskId, recordHome })`

Cuts the worktree again for a task that already ran once, and returns the
same `ProductionLine` shape. Two things differ from
`createProductionLine`: the branch `fabrica/<taskId>` must *already*
exist (it is checked out, not created), and nothing about the project's
current `HEAD` is involved - the reopened worktree starts from whatever
the previous round committed on that branch.

Both of those are what CONTRACT rule 6's "fix" verdict needs
(`src/foreman/README.md`). The workdir lands at the same
`<recordHome>/tasks/<taskId>/worktree` path as the first round on
purpose, not as a coincidence of sharing a path formula: a warm Worker's
resumable session is scoped to the `cwd` it was created in (see
`src/brain/adapters/`), so "the same warm worker" is only reachable from
the identical path.

Every refusal `createProductionLine` can raise applies here too, plus
`no-such-branch` and `branch-checked-out` (below) - including
`workdir-exists`, which still refuses rather than reusing a leftover
worktree, so a line has to be destroyed before it can be reopened.

### `productionLineBranchExists(project, taskId)` (module-private)

Plain boolean, never throws - true if `fabrica/<taskId>` already exists as
a local branch, false otherwise (including when `project` or `taskId`
themselves are bad, same as `safety.ts`'s `isKnownWorktree`). It is the
`refs/heads/` check `reopenProductionLine` uses internally to refuse
`no-such-branch`, and nothing else: not exported from `resume.ts`, not
re-exported from this module's barrel, so the rejected "decide from git
state" signal below isn't one import away.

**Not** what decides `createProductionLine` vs. `reopenProductionLine`
for a resumed task, on purpose (Client ruling, issue #8): an earlier
version of `src/foreman/do.ts`'s `runProductionRound` called this
directly to make that choice, on the theory that a first-ever round
could never see a branch already there. That was the weaker evidence -
a taskId is unique only within one record home (`registerTask` claims
`tasks/<id>/`), while branches live in the *project*, so a same-named
`fabrica/<taskId>` branch left by a different record home, a record home
recreated while the project's own branches survived, or a hand-made
branch, would all have been silently reopened and committed onto on what
was actually a task's first round - exactly where
`createProductionLine`'s own loud refusal is supposed to apply.
`runProductionRound` now takes an explicit `isRetry` the caller derives
from the *record* instead (`answer.ts`: this exact taskId, in this exact
record home, already has a `"line-cut"` event - proof a line was
genuinely cut for it once) - a claim only that task's own round can make
true, unlike a branch's mere existence in the project.

### Why this is checked here, not read out of git's own error (issue #170)

`reopenProductionLine` asks git's own worktree list, before it creates
anything, whether some worktree already has `fabrica/<taskId>` checked
out, and refuses with `branch-checked-out` when one does. The reopen
would fail either way - git will not check one branch out in two places -
so this check adds no safety git doesn't already provide. What it adds is
a message the Client can act on, for the one situation that produces it
in practice: reading a Worker's branch by hand in the project folder
(`git checkout fabrica/<taskId>`), then ruling `fix` without switching
back. Git's own refusal for that reads `fatal: 'fabrica/<taskId>' is
already used by worktree at '<project>'`, wrapped in `cut-failed` - true,
but it names neither the Client's own checkout as the thing in the way
nor what to do about it.

Matching that text instead of asking git for the facts was the obvious
shortcut and is the wrong one: git's wording here is version-dependent
("already used by worktree at" on git 2.54, "already checked out at" on
older ones), so a string match would quietly stop matching one day and
fall back to the cryptic message with nothing failing to say so. Reading
`git worktree list --porcelain` (`safety.ts`'s `listWorktrees`, already
the module's one parser of it) gives the same answer in a form that
doesn't drift.

The project's own checkout is told from any other worktree by *position* -
git always lists the main worktree first - never by comparing its path to
`project`, so the macOS `/var` -> `/private/var` symlink can't make one
directory look like two. Paths this message prints go through
`safety.ts`'s `realpathIfPresent` for the same reason, so what the Client
reads matches what they would type.

One deliberate asymmetry: this check never *causes* a failure. An
unreadable worktree list makes it return "nobody holds it" and fall
through to `git worktree add`, which then raises its own `cut-failed`
exactly as before. A better message is not worth a new way to fail.

## `rebaseOntoOriginDefault(line, { onConflict })` (issue #235)

Replays `line`'s own commits on top of origin's *current* default branch,
in `line`'s own worktree, with git and nothing else. A fix round ruled
days after the task ran would otherwise hand Inspector (and a reviewer) a
branch forked from a commit the project has long since moved past; this
is what keeps it current. `src/foreman/fix-rebase.ts` owns the policy
around it — when it runs, which conflict is reported and which is handed
to a worker — and `src/foreman/README.md`'s own section is where that
lives. This section is the git.

**Why it lives here, next to `cut.ts`.** `fetchOriginDefaultBranch` is
already the one place that answers "which branch does a task's base
commit come from", read straight from the remote and never assumed to be
`master`; asking that question a second way is how the two sides come to
disagree about what a task is forked from. And a rebase rewrites commits,
so this module's standing rule — never act on a path without first
proving through git itself that it is the exact throwaway worktree
expected — matters more here than anywhere else in it: a wrong path
costs a history, not a file.

**Three results, no fourth.** A conflict is a *result*, not a
`LineError`: the caller turns it into a delivery the Client rules on.
Only a rebase that failed for some other reason throws
(`rebase-failed`), and that is told apart from a conflict by asking git —
a rebase is in progress *and* has unmerged paths — never by reading its
wording.

- `already-current` — the branch already contains origin's tip
  (`git merge-base --is-ancestor`), so nothing is replayed. Skipped
  rather than done-for-nothing on purpose: rewriting the branch's commits
  would change every sha a reviewer has already looked at.
- `rebased` — the branch now sits on origin's tip, and `baseCommit` is
  that tip. The caller must pin a delivery's `files` diff to it; against
  the old base, the diff would list everything origin itself changed as
  this task's work.
- `conflicted` — carries every conflicted path git named, those files'
  marker hunks (capped, below), and `left`:
  - `"aborted"` (`onConflict: "abort"`) — `git rebase --abort`, so the
    branch is back at its own last commit and nothing is in flight.
  - `"stopped"` (`onConflict: "stop"`) — the rebase stays in progress
    with the markers in the working tree, for a worker that has been
    given instructions to resolve them in place.

**What is forced onto every history-writing call**, beyond what
`src/foreman/commit.ts` already forces for the same reasons (a throwaway
worktree has no claim on the Client's git identity or signing key, and a
project hook expecting installed dependencies would abort the rebase):
`rebase.autoStash=false`, so a Client who turned autostash on in his own
config does not get a worker's uncommitted work stashed into an entry
nothing here reads back; and `rerere.enabled=false`, so a conflict the
Client was never shown cannot be resolved on his behalf out of his own
recorded resolutions — the whole point of the conflict path is that he
sees the markers. `GIT_EDITOR`/`GIT_SEQUENCE_EDITOR` are pinned to `true`
as well: no step here is interactive, and a git that nonetheless reached
for an editor would hang the detached worker process forever instead of
failing.

### `finishRebase(workdir)`

Finishes a rebase left stopped: stages everything in the working tree and
continues, commit by commit, until it is done. The staging is deliberately
the host's job — a worker's git mounts are read-only by design
(`src/containment`), so a worker can resolve the markers in the files and
nothing more.

It refuses to stage anything while a conflict marker is still in the
working tree (`markers-remain`): committing `<<<<<<<` onto the branch
would hand Inspector and the Client something strictly worse than an
honest report that the conflict is unresolved. A later commit of the same
rebase can also conflict on its own, which no worker has been shown yet
(`new-conflict`). Either way the caller aborts and reports.

Two details worth knowing before changing it:

- **The marker check reads the working tree, not git's unmerged list.**
  A worker that deletes one marker line and leaves the other has resolved
  nothing, and git stops calling the file unmerged the moment it is
  staged — so the check is "does any line of this file open or close a
  conflict marker", over the file's own content.
- **`=======` on its own is deliberately not treated as a marker.** Git
  only ever writes it between the other two, while a row of exactly seven
  `=` is ordinary content (a markdown heading underline, a rule in a
  comment). Counting it would call genuinely resolved files unresolved,
  which costs the Client a round for nothing.
- **An empty resolution is skipped, not failed.** "Take the upstream side
  wholesale" is a legitimate resolution, and it leaves the replayed commit
  with nothing to record; `git rebase --continue` refuses that, so the
  index is compared against `HEAD` directly and `--skip` is used instead.
  Asked of the index, never inferred from git's own error text.

### How much of a conflict a report carries

`MAX_CONFLICT_LINES_PER_FILE` (200) and `MAX_CONFLICT_LINES_TOTAL` (2000),
per the Client's own ruling on issue #235 — and the rendering says so
wherever a cap cut something, naming how many marker lines of a file, or
how many whole files, were left out. The *file list* is never capped: the
Client always learns every path that conflicted, even when the quoted
hunks stop. A binary file, a file too large to quote, and a delete
conflict with no file in the working tree are each named with why rather
than quoted.

## `destroyProductionLine(line)`

Returns a `TeardownResult`: `{ status: "destroyed" }` when it actually
removed something, or `{ status: "already-destroyed" }` when there was
nothing left to remove — see "Idempotent teardown" below. Takes the whole
`ProductionLine` object it was handed back - not a loose
`taskId`/`recordHome`/`workdir` trio - and removes the worktree: the
directory at `line.workdir` and git's own bookkeeping for it.

It takes the whole object rather than separate parameters because it
re-derives the worktree path it expects to see, from `line.recordHome`
and `line.taskId` alone (`<recordHome>/tasks/<taskId>/worktree`), and
refuses to proceed unless that matches `line.workdir` exactly (see
`unsafe-teardown` below). Loose parameters would let a caller pass a
mismatched trio - a `recordHome` from one task paired with the
`workdir` of another, say - and delete the wrong directory, on the one
rule whose failure damages the Client's real work. Passing the object
`createProductionLine` or `reopenProductionLine` handed back is the only
way to call this function, so that mismatch can't happen by
construction.

What it deliberately leaves alone is the branch - `fabrica/<taskId>`
survives destruction exactly where its last commit left it. That's on
purpose: Fabrica itself never pushes or opens a pull request. On a
project without Inspector, the surviving branch is how the Client reviews
and merges or discards the work by hand. On a configured project,
Inspector receives that same checked-out branch and owns any publication
of green work; red work remains local (see `src/inspector/README.md`).

One consequence worth knowing: only what was *committed* inside the
worktree survives destruction, because a branch stores commits, not
working files. Anything a Worker left uncommitted when
`destroyProductionLine` runs is gone for good - it does not wait for or
require a clean tree first. (That is why the Foreman commits a Worker's
leftover changes onto the branch before tearing the line down - issue
#9, see `src/foreman/README.md`.)

## The `ProductionLine` fields

`ProductionLine` is declared once, in `contract/surface.ts` (issue #45)
- it is CONTRACT rule 1's central shape, so it lives with the contract
types like `Delivery` and `Receipt` do, not as a local `types.ts` here -
and this module imports it as a type only, which `import type` erases
at compile time so it creates no runtime dependency on `contract/`.

`ProductionLine` is what `createProductionLine` and
`reopenProductionLine` hand back - you never construct one by hand, so no
field is ever "left out." What matters instead is what each one is used
for, and what breaks if one ever holds the wrong value (a hand-edited or
stale object, say):

- **`taskId`** - the task id you passed in, unchanged. Builds the branch
  name and the workdir path, and is how `createProductionLine` detects
  a second create for the same task (see `workdir-exists` below).
- **`branch`** - `fabrica/<taskId>`. The one thing that survives
  destruction; it's what you hand the Client to review.
- **`project`** - the resolved root of your real checkout that this
  line was created from. Your working files there are never touched -
  but git's own worktree bookkeeping under
  `project/.git/worktrees/<name>` is not: `createProductionLine` creates
  it and `destroyProductionLine` removes it, because that bookkeeping is
  how a linked worktree exists at all, not something layered on top.
  That's expected, and it's still rule-1 compliant -
  `contract/helpers/fixture.ts`'s `fingerprint()` deliberately skips
  `.git` when it proves your checkout is unchanged byte for byte, for
  exactly this reason: rule 1 protects your working files, not git's
  own bookkeeping about them.
- **`workdir`** - the throwaway worktree path itself,
  `<recordHome>/tasks/<taskId>/worktree`.
- **`recordHome`** - the resolved record home this line's task folder
  lives under. `destroyProductionLine` recomputes
  `<recordHome>/tasks/<taskId>/worktree` from `recordHome` and `taskId`
  and refuses to proceed unless that matches `workdir` exactly - this is
  what catches a `ProductionLine` whose `workdir` was tampered with, or
  copied in from a different task.

`project`, `workdir`, and `recordHome` all come back fully resolved
(`realpath`'d), not as whatever string was passed in. On macOS a path
under `/var` is silently a symlink to `/private/var`, so an unresolved
path and its resolved form look like two different directories when
they're the same one - resolving both sides consistently is what keeps
this module's own path comparisons from being fooled by that.

## When it refuses

This module refuses rather than guesses whenever a path isn't exactly
what it should be. Every refusal is a `LineError` with a `code`; here is
what triggers each one and what to do about it.

- **`invalid-id`** - the task id isn't safe to use as a path segment and
  branch name. The full rule: it must start with a letter or digit, every
  character after that must be a letter, digit, `.`, `_`, or `-`, and
  `..` may never appear anywhere in it. An id starting with `-` or `.`
  (`-foo`, `.foo`) fails the first part of that rule, even though `-`
  and `.` are otherwise allowed later in the id. Use a plain id - the
  SPEC's own `YYYYMMDD-<slug>-<2 random chars>` format always qualifies.
- **`home-not-found`** - the `recordHome` you passed doesn't exist on
  disk. Create it first, or pass the record home you actually mean.
- **`not-a-repo`** - `project` doesn't exist, isn't inside a git
  repository, or is a subdirectory of one rather than its root. Point
  `project` at the repository's own root - the same path `git
  rev-parse --show-toplevel` would print from inside it.
- **`workdir-exists`** - a workspace already exists at
  `<recordHome>/tasks/<taskId>/worktree`. Task ids must be unique;
  generate a new one rather than reusing an old id, and if this is
  leftover state from a crashed run, look at that specific task folder
  before touching anything - this module never silently overwrites one.
  For that crashed-run case, `src/foreman/README.md`'s crash-window
  paragraph gives the concrete recovery: `git worktree remove`/`prune`
  the leftover worktree *and* `git branch -D fabrica/<taskId>`.
- **`fetch-failed`** - `createProductionLine` could not fetch `origin`,
  or could not read its default branch from the remote's own HEAD symref.
  Causes include: no `origin` remote configured on `project`, the remote
  being unreachable, or the remote never set its own HEAD (true of some
  hand-built bare repos - a real hosted remote, e.g. on GitHub, always
  has one). Read the wrapped git error in the message; nothing is created
  - no task folder, no worktree - when this fires.
- **`cut-failed`** - `git worktree add` itself failed, most often
  because the branch `fabrica/<taskId>` already exists from an earlier
  run that used this same id. Read the wrapped git error in the message;
  it names the actual cause.
- **`no-such-branch`** - `reopenProductionLine` was asked for a task with
  no *local branch* `fabrica/<taskId>` in `project`. A line can only be
  reopened for a task that already ran once through
  `createProductionLine`; this is the mirror image of `cut-failed`'s
  usual cause. Only `refs/heads/` counts: another kind of ref carrying
  that same name (a tag, say) is not a branch to commit onto, so it is
  refused rather than reopened - see `resume.ts` for what checking it out
  would cost.
- **`branch-checked-out`** - `reopenProductionLine` was asked for a task
  whose branch `fabrica/<taskId>` some *other* worktree already has
  checked out, and git cannot check one branch out in two places. Nearly
  always that other worktree is the project folder itself, because the
  Client ran `git checkout fabrica/<taskId>` to read what a Worker did and
  then ruled `fix` without switching back; the message says so, naming
  the folder, and the fix is to switch that checkout to another branch
  and rule `fix` again. Nothing is created when this fires - no worktree,
  no commit - so the task is left exactly as resumable as it was. If the
  holder is some *other* worktree instead (a hand-made one, or a leftover
  from a different record home), the message names that path instead and
  asks for it to be removed or switched. `reopenProductionLine`'s own
  "Why this is checked here, not read out of git's own error" section
  has the reasoning.
- **`unsafe-teardown`** - `destroyProductionLine` won't touch
  `line.workdir` because it can't confirm, via git's own worktree list,
  that the path is a registered *linked* worktree of `project` and not
  the project's main checkout, not somewhere unrelated, and not a path
  that no longer matches what `recordHome` and `taskId` compute. This
  should never fire for a genuine, untouched `ProductionLine` - if it
  does, treat it as the safety check working as intended and find out
  why the object doesn't match reality, rather than working around it.
- **`teardown-failed`** - git's own `worktree remove` failed for a
  reason other than the safety checks above. Read the wrapped git error
  in the message.
- **`not-a-worktree`** and **`unsanitizable-config`** - the two refusals
  the git-under-containment helpers raise; see
  `resolveCommonGitDir(workdir)` and `writeSanitizedGitConfig(commonGitDir)`
  below for exactly what triggers each.

## Idempotent teardown

Destroying a line whose worktree is already gone — a second call in a
cleanup path, or a worktree removed out of band (a manual `git worktree
remove`, say) — returns `{ status: "already-destroyed" }` rather than
throwing. This matters because `src/foreman/` (issue #7) calls
`destroyProductionLine` from the loop's cleanup path, where a double
teardown is easy to reach: a failure after teardown already ran, for
instance.

The check is narrow on purpose, so it can't paper over a genuine
`unsafe-teardown`: it only fires once `line.workdir` has already passed
both safety checks above (it's exactly the path this task's line should
be at, and `line.project` resolves), and only when the worktree is gone
*both* from disk and from git's own worktree list. A path that still
exists on disk but was never a registered worktree — the spoofed and
tampered cases above — still throws `unsafe-teardown` exactly as before;
only a path that legitimately once was this line and now isn't anywhere
reads as "already destroyed."

## `resolveCommonGitDir(workdir)`

Finds the real project's shared `.git` — the object database, refs, and
config every worktree of that project points back to — from a
`ProductionLine` workdir alone, no `ProductionLine` object needed. Built
for issue #44 (containment): `git worktree add` always leaves
`<workdir>/.git` as a one-line pointer file, `gitdir: <project>/.git/
worktrees/<taskId>` — a real, absolute host path outside `workdir`
entirely. This function reads that pointer, then reads *its* own
`commondir` file (a path relative to the worktree-internal directory) to
resolve the actual shared `.git`, and returns it `realpathSync`'d.

The reason this takes `workdir` alone, not a `ProductionLine`: it exists
to be called from the reference CLI adapter's own `work(brief, workdir,
opts)` (`src/brain/adapters/`), and `contract/surface.ts`'s `Brain`
interface has no room to also pass `project` or `taskId` through —
`workdir`'s own pointer file already names them, so nothing else is
needed.

Throws `LineError("not-a-worktree")` when `<workdir>/.git` isn't a
worktree pointer file at all (a plain directory with no `.git`, or one
that's already a real `.git` directory rather than a worktree's), and
also when the pointer chain is broken - the pointer parses but the
shared `.git` it ultimately names no longer exists on disk. The
no-`.git` message is written as an instruction to the Client - Fabrica
needs a git repository in the working directory, so initialize git
there first - and callers are expected to let it surface rather than
catch it and degrade: the reference CLI adapter deliberately has no
no-git fallback, so a Worker never runs with git silently
unavailable.

What it's *for*: mounting the result read-only into a container lets
git work at all inside one, without exposing write access to the
Client's real repository — see `../containment/README.md`'s "Git under
containment" for what that unlocks and why a commit attempt still fails
(deliberately) even with this mounted in.

## `writeSanitizedGitConfig(commonGitDir)`

The companion to the mount above: the shared `.git`'s `config` is the
one file in it that can carry a credential (a remote URL, an
`extraheader` line, an `insteadOf` rewrite, a credential-helper
setting), so the real config must never be visible inside a container.
This writes a throwaway copy that forwards **only the `[core]` section
and individually allowlisted, credential-free `[extensions]` keys**
and drops every other section by default - an allowlist, so anything
not explicitly forwarded is invisible by construction, rather than a
denylist that fails open on the first unanticipated form; a
`[core]`-only config is enough for an ordinary repo, since git refuses
to detect a repository with no config at all but works normally with
just `[core]`, while `[extensions]` keys are structural and their
absence would make git misread the repo - into its own temp directory,
and returns the copy's path for the caller to shadow-mount over the
real config's path and delete after the call (the reference CLI
adapter does both). Throws the same `LineError("not-a-worktree")` when
the config can't be read at all, and
`LineError("unsanitizable-config")` for any `[extensions]` content it
can't prove credential-free, naming it - never silently dropped, never
passed through. See `../containment/README.md`'s "Git under
containment" for the exact key list, everything else that refuses the
run, why `worktreeConfig` is deliberately excluded, and the known
`partialClone` limitation.
