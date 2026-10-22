# `fabrica do --issue N` now reads the issue, and `src/github/` exists

Durable facts from the task "make `fabrica do ... --issue N` fetch that
issue's title and body from GitHub at registration".

## There is now one module for GitHub's HTTP API: `src/github/`

Before this, every GitHub API call Fabrica made was either `gh` in a
shell script (`.github/scripts/sync-inspector-contract.sh`) or
Inspector's job. `src/github/` is the first TypeScript-side reader:
parsing of the three `--issue` spellings (`N`, `owner/repo#N`, a pasted
issue URL), and one documented `GET
/repos/{owner}/{repo}/issues/{N}` through an injectable `fetch`. It
knows nothing about tasks, the record, or git — resolving a bare number
against a project's `origin` and everything record-shaped is
`src/foreman/task-issue.ts`. Put the next read-only GitHub call here,
and keep that split.

The API version is pinned in one place (`GITHUB_API_VERSION`), read off
GitHub's current REST reference rather than remembered.

## A plain HTTPS call, not `gh`, and why that matters beyond style

`gh issue view --json` would have been shorter, and `gh` is already
needed for the token. It was rejected for three reasons worth keeping:
it needs the binary even when `GITHUB_TOKEN` is set, it adds a second
spelling of "which issue, which repository" between the Client's flag
and the request, and **a child process is the one thing `src/foreman`
may not spawn for anything but git** —
`src/foreman/no-host-check.test.ts` reads every production file in that
directory and fails on any `child_process` call whose first argument
isn't `"git"`. Any future foreman-side integration has the same
constraint: do the work over HTTP, or put the process spawn in another
module.

## The injectable seam had to cover origin resolution too, not just the fetch

`IssueReader` (`src/foreman/task-issue.ts`) is one object with two
halves: `projectRepo(project)` and `issue(ref)`. The obvious design —
inject only the fetch — does not work in this codebase, and the reason
is a property of the test fixtures: `contract/helpers/fixture.ts` points
every fixture project's `origin` at a throwaway **local bare mirror**,
so a fixture has no github.com remote and a bare `--issue 186` could
never resolve, however good the fake issue was. Any future seam that
reads "what GitHub repository is this project" has the same problem.

## Cross-repository closing keywords are real, and are spelled out

GitHub's "Linking a pull request to an issue" documents `KEYWORD
OWNER/REPOSITORY#ISSUE-NUMBER` for an issue in another repository, so
`withClosesLine` (`src/foreman/pr-body.ts`) renders `Closes
owner/repo#45` when the task's issue is not in the repository the pull
request is opened in, and the task record's `issue` file holds that same
qualified spelling. A bare `Closes #45` there would have closed whatever
issue happened to carry that number in the project's own repository —
the one outcome worse than closing nothing.

The `issue` record file therefore has two legal spellings now (`186` and
`owner/repo#45`). `src/github`'s `parseStoredIssue` is the only reader;
it answers `undefined` for anything it cannot read rather than a
half-read number, because a wrong number here closes a real issue.

## `ForemanOptions` is where parallel tasks collide, every time

Two spots in `src/foreman/foreman.ts` are a single shared line each, and
every task that adds an injectable seam edits both: the optional field on
`ForemanOptions`, and the one-line options object `do()` passes to
`doTask`. This task and issue #267 (`checksReader`) landed in the same
window and conflicted on exactly those two spots, nowhere else — the
resolution is always "keep both", since the fields are independent.
Expect it, and resolve it that way rather than reasoning about it afresh.

Which of `do`/`answer`/`verdict` a new seam is threaded through is not
uniform, and the asymmetry is deliberate: `checksReader` goes to all
three (every round can reach a published pull request), `issueReader`
only to `do()` (the issue is fetched once at registration and frozen, so
a resumed or fix round reads the record instead). A new seam needs that
question answered rather than copied from its neighbour.

## The clarifying step shares the brief builder

`brain.ask()` is handed the same issue section every round's worker gets
(`withIssueText`), which is the whole point of fetching at registration:
"do issue #N as written" is unanswerable at the clarifying step
otherwise. `withIssueText` is idempotent (it keys on its own heading),
because `workerBrief` and `attempts.ts` both re-apply brief builders to
briefs that may already carry them.
