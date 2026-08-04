# ProductionLine

A ProductionLine is a throwaway copy of your project, checked out on its
own branch, where one task's work and its checks happen. It exists so
your real checkout is never touched - not a stray file, not an index
change, not a stash - which is CONTRACT rule 1, the rule whose failure
damages your actual work instead of a copy.

## `cutLine({ project, id, home })`

Creates the throwaway copy: a git *worktree* linked to `project`,
checked out on a fresh branch named `fabrica/<id>`. A worktree is git's
own mechanism for a second working directory that shares one
repository's history with the first - no clone time, and it starts from
exactly whatever commit `project` currently has checked out.

The workdir always lands at `<home>/tasks/<id>/worktree`. The branch is
named `fabrica/<id>` rather than something free-form for two reasons:
every task's branch sits under one `fabrica/` namespace, so
`git branch --list 'fabrica/*'` finds all of them at a glance, and the
id ties the branch back to that exact task's own record on disk
(`<home>/tasks/<id>/`) one-to-one.

```
cutLine({
  project: "/Users/ari/inkling-umbrella/spending-app",
  id: "20260804-fix-flaky-test-4f",
  home: "/Users/ari/.fabrica",
})
```

returns a `ProductionLine`:

```
{
  id: "20260804-fix-flaky-test-4f",
  branch: "fabrica/20260804-fix-flaky-test-4f",
  project: "/Users/ari/inkling-umbrella/spending-app",
  workdir: "/Users/ari/.fabrica/tasks/20260804-fix-flaky-test-4f/worktree",
  home: "/Users/ari/.fabrica",
}
```

Everything a Worker or a check does for this task should happen inside
`workdir` and nowhere else.

## `tearDownLine(line)`

Removes the worktree: the directory at `line.workdir` and git's own
bookkeeping for it. What it deliberately leaves alone is the branch -
`fabrica/<id>` stays exactly where its last commit left it. That's on
purpose: v1 never pushes and never opens a pull request, so the branch
sitting there untouched is how the Client reviews the work afterward and
merges or discards it by hand (SPEC.md).

One consequence worth knowing: only what was *committed* inside the
worktree survives teardown, because a branch stores commits, not working
files. Anything a Worker left uncommitted when teardown runs is gone for
good - teardown does not wait for or require a clean tree first.

## The `ProductionLine` fields

`ProductionLine` is what `cutLine` hands back - you never construct one
by hand, so no field is ever "left out." What matters instead is what
each one is used for, and what breaks if one ever holds the wrong value
(a hand-edited or stale object, say):

- **`id`** - the task id you passed in, unchanged. Builds the branch
  name and the workdir path, and is how `cutLine` detects a second cut
  for the same task (see `workdir-exists` below).
- **`branch`** - `fabrica/<id>`. The one thing that outlives teardown;
  it's what you hand the Client to review.
- **`project`** - the resolved root of your real checkout that this
  line was cut from. Your working files there are never touched - but
  git's own worktree bookkeeping under `project/.git/worktrees/<name>`
  is not: `cutLine` creates it and `tearDownLine` removes it, because
  that bookkeeping is how a linked worktree exists at all, not
  something layered on top. That's expected, and it's still rule-1
  compliant - `contract/helpers/fixture.ts`'s `fingerprint()`
  deliberately skips `.git` when it proves your checkout is unchanged
  byte for byte, for exactly this reason: rule 1 protects your working
  files, not git's own bookkeeping about them.
- **`workdir`** - the throwaway worktree path itself,
  `<home>/tasks/<id>/worktree`.
- **`home`** - the resolved record home this line's task folder lives
  under. `tearDownLine` recomputes `<home>/tasks/<id>/worktree` from
  `home` and `id` and refuses to proceed unless that matches `workdir`
  exactly - this is what catches a `ProductionLine` whose `workdir` was
  tampered with, or copied in from a different task.

`project`, `workdir`, and `home` all come back fully resolved
(`realpath`'d), not as whatever string was passed in. On macOS a path
under `/var` is silently a symlink to `/private/var`, so an unresolved
path and its resolved form look like two different directories when
they're the same one - resolving both sides consistently is what keeps
this module's own path comparisons from being fooled by that.

## The refusals

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
- **`home-not-found`** - the record `home` you passed doesn't exist on
  disk. Create it first, or pass the record home you actually mean.
- **`not-a-repo`** - `project` doesn't exist, isn't inside a git
  repository, or is a subdirectory of one rather than its root. Point
  `project` at the repository's own root - the same path `git
  rev-parse --show-toplevel` would print from inside it.
- **`workdir-exists`** - a workspace already exists at
  `<home>/tasks/<id>/worktree`. Task ids must be unique; generate a new
  one rather than reusing an old id, and if this is leftover state from
  a crashed run, look at that specific task folder before touching
  anything - this module never silently overwrites one.
- **`cut-failed`** - `git worktree add` itself failed, most often
  because the branch `fabrica/<id>` already exists from an earlier run
  that used this same id. Read the wrapped git error in the message; it
  names the actual cause.
- **`unsafe-teardown`** - `tearDownLine` won't touch `line.workdir`
  because it can't confirm, via git's own worktree list, that the path
  is a registered *linked* worktree of `project` and not the project's
  main checkout, not somewhere unrelated, and not a path that no longer
  matches what `home` and `id` compute. This should never fire for a
  genuine, untouched `ProductionLine` - if it does, treat it as the
  safety check working as intended and find out why the object doesn't
  match reality, rather than working around it.
- **`teardown-failed`** - git's own `worktree remove` failed for a
  reason other than the safety checks above. Read the wrapped git error
  in the message.

## A known rough edge

Tearing down a line that's already gone currently surfaces as
`unsafe-teardown` - the same "this isn't a registered worktree" message
you'd get for a genuinely wrong path, not a clearer "already torn down."
That's a real rough edge, not a hidden one: it's being handled where it
actually bites, in issue #7, once something is calling `tearDownLine` as
part of a real retry/failure path rather than once per task.
