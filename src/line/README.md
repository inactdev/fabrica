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
repository's history with the first - no clone time, and it starts from
exactly whatever commit `project` currently has checked out.

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
`no-such-branch` (below) - including `workdir-exists`, which still
refuses rather than reusing a leftover worktree, so a line has to be
destroyed before it can be reopened.

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
purpose: v1 never pushes and never opens a pull request, so the branch
sitting there untouched is how the Client reviews the work afterward and
merges or discards it by hand (SPEC.md).

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
