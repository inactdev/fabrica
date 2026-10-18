# Issue #235: a fix round rebases onto origin's default branch first

Durable facts from implementing issue #235 (the host-side rebase before
every fix round, and the conflict path that hands it to the Client).

## Where the two halves live

- `src/line/rebase.ts` — the git. `rebaseOntoOriginDefault`,
  `finishRebase`, `abortRebase`, `rebaseInProgress`, `describeConflict`,
  and the two marker caps. Deliberately next to `cut.ts`, which already
  owns `fetchOriginDefaultBranch` ("which branch does a task's base
  commit come from"), so that question is still answered in exactly one
  place. A conflict is a **result** here, never a `LineError` — only a
  rebase that failed for another reason throws (`rebase-failed`), and the
  two are told apart by asking git (a rebase is in progress *and* has
  unmerged paths), never by reading its wording.
- `src/foreman/fix-rebase.ts` — the policy, with the whole Client ruling
  written out in its header. `src/foreman/README.md`'s "A fix round
  starts by rebasing onto origin's default branch" is the Client-facing
  version; `src/line/README.md`'s own section covers the git.

## Two new `LineErrorCode`s

`unsafe-rebase` (the path is not this line's own worktree on this line's
own branch, or a rebase is already in flight there) and `rebase-failed`.
`unsafe-rebase` is this module's path-safety rule applied where it
matters most: a rebase rewrites commits, so a wrong path costs a history
rather than a file. `requireLinkedWorktree` already refuses the Client's
own checkout; the branch check is the second half, since a worktree at a
detached HEAD is not the thing the rebase was asked to move.

## The seam this needed in `attempts.ts`

`runAttempts` gained an optional `beforeCommit(attempt)`, running after
`work()` returns and before the attempt's own commit, able to preempt the
judgement. It exists because finishing a stopped rebase has to happen
between those two points — the commit assumes a branch the rebase has
stopped moving — and nothing else in the loop offered that point. Reuse
it for any other host-side git step with the same ordering requirement
rather than adding a second hook; returning a `Judgement` from it means
"this attempt is judged on that step alone, never committed, never handed
to a check or Inspector", the same shape an invalid write-up already has.

## Git flags that are not optional here

Beyond what `src/foreman/commit.ts` already forces (machine identity, no
gpg signing, `core.hooksPath=/dev/null`):

- `rebase.autoStash=false` — a Client with autostash on in his own config
  would otherwise get a worker's uncommitted work stashed into an entry
  nothing here ever reads back.
- `rerere.enabled=false` — rerere would resolve a conflict out of the
  Client's own recorded resolutions, so a conflict he was never shown
  could be applied on his behalf. The conflict path exists precisely so
  he sees the markers.
- `GIT_EDITOR`/`GIT_SEQUENCE_EDITOR=true` — nothing here is interactive,
  and a git that reached for an editor anyway would hang the detached
  worker process forever rather than fail.

## Sharp edges found while building it

- **The rebase state directory is not under the workdir.** A
  ProductionLine is a *linked* worktree, so git keeps its rebase state in
  the project's `.git/worktrees/<name>/`. Resolve it with
  `git rev-parse --git-path rebase-merge` (and `rebase-apply`), never by
  joining `.git/` onto the workdir.
- **"Markers remain" must read the working tree, not git's unmerged
  list.** A file stops being unmerged the moment it is staged, and a
  worker that deletes one marker line and leaves the other has resolved
  nothing. The check is "does any line open or close a conflict marker",
  over the file's own content.
- **`=======` alone is deliberately not treated as a marker.** Git only
  writes it between the other two, while a row of exactly seven `=` is
  ordinary content (a markdown heading underline). Counting it would call
  genuinely resolved files unresolved, costing the Client a round for
  nothing.
- **An empty resolution needs `--skip`, not `--continue`.** "Take the
  upstream side wholesale" is legitimate and leaves the replayed commit
  with nothing to record; `--continue` refuses that. Decide it by
  comparing the index against `HEAD` directly, never by matching git's
  error text.
- **`baseCommit` moves after a successful rebase.** Origin's tip becomes
  the branch's fork point, so that is what the round's `"delivered"` event
  records and what `diffFiles` is pinned to. Against the old base, the
  delivery's `files` list would name everything origin itself changed as
  this task's work.
- **`skipIfUnchanged`'s `priorHead` has to be read after the rebase**, or
  a round that only rebased looks like one whose worker changed
  something. On the stopped-rebase path the wrapper is skipped entirely:
  HEAD is detached mid-rebase and the host moves it again afterwards.

## Running this repo's tests without npm

Worth knowing if a box has no registry access: Node 24 strips TypeScript
natively, so `node --test $(find contract src integrations -name
'*.test.ts')` runs the suite with no `tsx` at all. Two consequences — it
does **not** typecheck (`npm test`'s first step is `tsc --noEmit`, which
needs the real dependency), and every test that spawns a detached child
through `src/cli/bin.mjs` fails, since that path genuinely imports `tsx`.
`src/config/` also needs `smol-toml` at runtime. Neither is a reason to
change anything in the repo; it is just what a sandboxed run can and
cannot prove.
