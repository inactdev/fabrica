# Issue #96's test pass now defers to Inspector's examiner

`.github/workflows/rule9-gate.yml`'s third matching pass (the temporary
`*.test.ts` one from issue #96) no longer fails every test change
outright. It now names the first changed test file and then reads the
pull request head's `inspector-tests` commit status, with four outcomes
and four separate messages:

- `success` → every changed `*.test.ts` in the pull request is cleared.
  The judgment is deliberately per commit, not per file (Client
  clarification, 2026-10-18): the examiner reads the whole proposed
  change, so there is nothing per-file for the gate to split apart.
- any other state, `pending` included → red. Pending is red *without
  waiting*, on purpose: the gate re-runs on every push, and Inspector
  posts its statuses before it moves the branch, so a pending state
  means something went wrong rather than "not yet". There is no polling
  and no timeout anywhere in this pass, and adding one would be a
  behaviour change, not a robustness improvement.
- no such status at all → red, worded separately from the above, because
  "never judged" and "judged and not green" are different situations for
  whoever reads the failure.
- the status could not be read (network, rate limit, permissions, a
  malformed response) → red, worded separately again. The `gh api` call
  is written as `if ! tests_state=$(gh api ...)` precisely so a failed
  read can never be confused with the empty output a context that posted
  nothing produces — `bash -e` inside a command substitution would not
  have told the two apart.

## Two decisions worth not re-litigating

**The status is read lazily, inside `if [ -n "$touched_test" ]`.** An
earlier shape read it up front next to the changed-file listing and used
it as a boolean guard — simpler control flow, but then every pull
request, including ones touching no test at all, depends on a successful
statuses read. A rate-limit hiccup would then fail changes the clearance
has no bearing on. The fail-closed surface is kept as narrow as the
change it is judging.

**The clearance lives only in the third pass.** Rule 9's own pass and the
contract pass are untouched and must stay that way — neither is
Inspector's to clear. `contract/rule9-gate.contract-paths.test.ts`
asserts both loop bodies mention nothing about Inspector, so an attempt
to extend the clearance upward fails loudly rather than quietly.

## The job needs `statuses: read`

Added alongside the existing `pull-requests: read`. Same minimum scope
the `inspector-stamp` job in the same file already declares for the same
combined-status endpoint; the contract test also asserts the job requests
no write scope at all.

## The matching half can be exercised without GitHub

The whole `run:` body is ordinary bash reading only environment
variables and `gh`. Extracting that block and running it with a fake `gh`
on `PATH` (one responding to `*/pulls/*/files*` and
`*/commits/*/status`) exercises every branch — rule 9, contract, cleared,
pending, missing, unreadable, renames, the 3000-file cap — in under a
second, with no GitHub access. Worth redoing that way before touching
this step again; the contract test proves the file's *shape*, not its
behaviour.

## `.inspector.json` is the Client's, not Fabrica's

The clearance only ever arrives if the examiner is actually asked for a
judgment, which is a `testPaths` entry (spelled `*.test.ts`, no
directory scope, matching how `protectedPaths` in that same file is
already spelled) in the project's `.inspector.json`. That file is the
Client's to edit; a task declares the needed entry in its pull request
body instead of editing it. Until it is there, the pass behaves exactly
as it did before this change — no status, therefore red.
