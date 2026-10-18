# Issue #170: saying plainly that a task's branch is checked out in the project folder

## The durable facts

**Git's "one branch, one worktree" refusal has version-dependent
wording.** On git 2.54 the failure from `git worktree add <path>
<branch>` when `<branch>` is already checked out somewhere reads:

```
fatal: 'fabrica/<taskId>' is already used by worktree at '<project>'
```

Older gits worded the same condition "is already checked out at". Nothing
in this repo may key on either spelling. When a git refusal needs to be
turned into a message for the Client, ask git for the *facts* instead -
here, `git worktree list --porcelain` via `src/line/safety.ts`'s
`listWorktrees`, which is already this module's one parser of that output.

**`listWorktrees`' first entry is always git's main worktree.** That
position is how `src/line/resume.ts` tells "the project's own checkout
holds this branch" from "some other worktree holds it", rather than
comparing the entry's path to `project`. Deliberate: the macOS
`/var` -> `/private/var` symlink makes two spellings of one directory,
and a positional test can't be fooled by it. `safety.ts`'s
realpath-or-as-is helper is now exported as `realpathIfPresent` (it was
the module-private `normalize`) because paths *displayed* in a message
need the same normalisation that paths *compared* to each other always
did - a message should name a path the way the Client would type it.

**A message-improving check must never become a new way to fail.**
`worktreeHoldingBranch` in `resume.ts` returns null if the worktree list
can't be read at all, falling through to `git worktree add`'s own
`cut-failed`. The pattern generalises: a pre-flight check whose only
purpose is a better error should be strictly additive to the failure
modes already there, never a replacement for them.

## Where this lands for the Client

`fabrica verdict <id> fix` records the ruling in the foreground and runs
the round detached (issue #123), so this refusal does not surface as that
command's exit code. It reaches the Client as the task's `task-failed`
event message, read through `fabrica status`/`log`/`watch` - which is why
the message itself has to carry the remedy ("switch that checkout to
another branch and try again") rather than relying on anything printed
around it.

## Verification gap on the box this was written on

`npm test` could not run here: the npm registry was unreachable, so
`node_modules` was absent - no `tsx`, no `typescript`, no `smol-toml`.
Node 24's built-in type stripping runs the suite directly
(`node --test <files>`), which is enough for anything that doesn't import
a dependency or spawn `tsx`, and is worth knowing as a fallback. It is
*not* a typecheck: `tsc --noEmit`, the first half of `npm test`, has no
substitute here.
