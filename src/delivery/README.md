# Delivery validation

A `Delivery` is the block of fields `fabrica do` hands back to the Client
at the end of a task - confidence, what happened, evidence, and so on
(`contract/surface.ts`'s `Delivery` type). This module is what stands
between a `Delivery` object and the Client actually seeing it: CONTRACT
rule 4, "it never guesses silently." A delivery that's missing a required
field, or whose `files` list doesn't match what its branch actually
contains, is malformed and must never be presented as done.

## `validateDelivery(value, project?, base?)`

```ts
validateDelivery({
  outcome: "done",
  confidence: 85,
  summary: "added the export button",
  evidence: "./check.sh -> exit 0",
  assumptions: "dates are year-month-day",
  gaps: "no tests for empty lists",
  branch: "fabrica/20260803-export-ab",
  files: ["app.txt"],
  gateChanges: "",
});
```

Checks that every field `Delivery` requires is actually present and the
right shape - `outcome` is one of the three literal strings, `confidence`
is a finite number, `files` is an array of strings, the rest are strings.
Throws a `DeliveryError` (`code: "malformed"`) naming the first field
that's wrong, so the message itself says what to fix.

An empty string passes. `gaps: ""` and `assumptions: ""` are legitimate
answers - "there were no gaps" - not missing data; only an absent or
wrong-typed field counts as malformed. Same for `files: []`: a task that
touched nothing is a real outcome, not an incomplete one.

Called with one argument, this never touches the filesystem or git - it
works on a delivery that's nothing but a plain object, the same way the
CONTRACT rule 4 test constructs most of its cases by hand. That is also
exactly why it *cannot* check whether `files` is actually true on its
own: proving that needs a real git repository to diff against, which a
bare object never has.

Pass `project` (the second, optional argument - the Client's real
checkout, same as `validateDeliveryFiles` below takes) and this also
proves the `files` claim, by delegating to `validateDeliveryFiles`
internally - there's exactly one place that logic lives, called either
directly or through here. Omit `project` and that check is skipped
entirely, not silently passed: nothing about `files` is claimed either
way. `base`, the third optional argument, is passed straight through to
`validateDeliveryFiles` - see `diffFiles` below for what it pins.

## `validateDeliveryFiles(delivery, project, base?)`

```ts
validateDeliveryFiles(delivery, "/Users/ari/inkling-umbrella/spending-app");
```

Diffs `delivery.branch` against its fork point inside `project`'s own git
history (via `diffFiles`, below) and compares the result to
`delivery.files`. Any disagreement - a file the delivery claims but the
branch never touched, or one the branch touched but the delivery left
out - throws a `DeliveryError` (`code: "files-mismatch"`) naming both
lists, so the mismatch is visible, not just "invalid."

This is "claims verified by code, not taken on faith": nothing about the
`files` field is ever trusted just because a `Delivery` object says so.

`project` is the Client's real checkout, not the throwaway ProductionLine
workdir - see `diffFiles` below for why that distinction is what makes
this work even after the task's worktree is gone.

## `diffFiles(project, branch, base?)`

```ts
diffFiles(project, "fabrica/20260803-export-ab");
// -> ["app.txt", "new-file.txt"]
```

The one function that turns "a branch" into "the files it actually
changed": `git diff --name-only` between a fork point and `branch`. It
reads from `project`'s own git history, never a ProductionLine's
`workdir` - which matters because `destroyProductionLine`
(`src/line/teardown.ts`) removes the *worktree* but never the branch or
its commits, so this still works after that worktree is gone. Both
`src/foreman/do.ts` (building a delivery's `files` field) and
`validateDeliveryFiles` above (re-checking one) call this same function,
so there is exactly one definition of "what a branch touched" that the
two could ever disagree about.

The fork point is `base` when given - the foreman loop records it with
`baseCommitOf` (below) the moment the ProductionLine is cut, so the
files list can't drift if the Client's own checkout moves to a different
branch while the task is still running. When `base` is omitted, the fork
point falls back to `git merge-base` against `project`'s current `HEAD` -
a caller holding nothing but a bare delivery (the CONTRACT rule 4 test)
has no ProductionLine to pin a base from.

A branch that can't be diffed at all - a fabricated or missing branch
name, most likely - throws a `DeliveryError` (`code:
"branch-unreadable"`) carrying git's own stderr, never a raw
child-process exception: a branch a delivery merely claims to exist is
an untrusted claim like any other.

## `baseCommitOf(workdir)`

```ts
baseCommitOf(line.workdir);
// -> "3f9c2ab..."
```

`git rev-parse HEAD` in a workdir - the foreman loop calls this on a
fresh ProductionLine's worktree, before any worker attempt runs, to
record the exact commit the line was cut from, and passes it back in as
`diffFiles`'s `base` when building and validating the delivery.

## The files-list-vs-teardown decision

PR #43's review flagged a real tension and left it for this module to
resolve: a ProductionLine's worktree is force-removed at teardown
(`git worktree remove --force`), which destroys anything a Worker left
*uncommitted*. Before this module existed, the delivery's `files` field
was read from that uncommitted working tree (`git status --porcelain`)
moments before it vanished - so `files` could name real work that no
longer exists anywhere, while `branch` pointed at a branch with nothing
ever committed to it. The delivery could name the files or preserve the
work, but never both.

The fix is in `src/foreman/do.ts`, not in this module: it commits
whatever a Worker left in the worktree, on the ProductionLine's own
branch, before teardown runs (`commit.ts`'s `commitWorktreeChanges`).
`files` is then read back from that commit via `diffFiles`, so it and
`branch` describe the exact same surviving reality - the mismatch this
module exists to catch stops being possible in the one caller that
matters, by construction, rather than by validating around it. This
is a genuine behavior change (a new commit `do()` makes that it didn't
before), not a validation-only fix, chosen because `src/line/README.md`
already documented "the branch is what the Client reviews and merges
by hand" as the design intent - a commit was always the missing half of
that promise, not a new decision this module invented.

The one outcome handled differently is `discarded-protected-path`: rule
9 discards the work, so nothing may land on the branch and `files`
honestly comes back empty. Everything changed since the fork point is
captured to the task's record folder as `discarded.patch` instead
(`src/foreman/discard.ts`), and the branch ref is forced back to the
fork point - see "Rule 9 and this module" below.

## Errors

`DeliveryError` carries a `code`:

- **`malformed`** - `validateDelivery` rejected the object; the message
  names the field.
- **`files-mismatch`** - `validateDeliveryFiles` found the `files` list
  disagrees with the branch's real diff; the message shows both lists.
- **`branch-unreadable`** - `diffFiles` couldn't diff the branch at all
  (most likely a fabricated or missing branch name); the message names
  the branch and project and carries git's own stderr.

## Rule 9 and this module

CONTRACT rule 9 ("it can't grade its own homework in the dark") is
detected in `src/foreman/gate-changes.ts`, not here - `do.ts` already
knows, before it ever builds a `Delivery`, whether an undeclared gate
change forces `outcome: "discarded-protected-path"`. This module doesn't
re-check that: `gateChanges` is validated the same as any other required
string field (present, right type), and an empty string is a legitimate
"the gate was untouched," not a violation. Duplicating rule 9's detection
here would just be a second place for it to disagree with the first.

What a discarded outcome means for this module's checks: for
`discarded-protected-path`, `do.ts` skips the commit-before-teardown
AND forces the ProductionLine's branch ref back to the exact commit the
line was cut from - rule 5 keeps the EVIDENCE (delivery, receipts,
transcript stay on the record) while rule 9 discards the WORK, and
leaving discarded work reachable on a mergeable branch would blur
exactly that line. The ref move matters because a Worker has full git
access inside the worktree and may have committed its own changes;
merely skipping Fabrica's commit would leave those on the branch tip.
With the branch back at the fork point, `diffFiles(project, branch,
base)` naturally reports an empty `files` list - no special-casing.
Because a declaration mistake shouldn't destroy good work, everything
changed since the fork point (commits and uncommitted edits alike,
`--binary` so it stays `git apply`-able) is first saved to the task's
record folder as `discarded.patch`, and the delivery's `gaps` field says
where it landed and how to run the task again with the gate change
declared.
