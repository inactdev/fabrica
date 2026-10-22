# Inspector handoff

`src/inspector/` is Fabrica's adapter for the independently run `inspector` command. A task requires inspection when its base commit contains `.inspector.json`; Worker changes cannot opt out or weaken inspection by changing it. Any final config blob that differs from the base commit, including deletion, is an Inspector refusal rather than a skip. The adapter turns Inspector's exit codes into `green`, `red`, or `refused` without treating a refusal as a red verdict.

The handoff is trigger-driven: after each attempt's work is committed, the Foreman invokes Inspector directly and waits for that process. Fabrica runs no check of its own (issue #64); Inspector's run is the verdict, and a red report becomes the next attempt's correction brief. The call is `inspector -repo <worktree> -branch fabrica/<taskId>`: Inspector requires `-branch`, the one branch it may publish to after a green result. Neither module polls for an Inspector result. Exit 0 is `green`, exit 1 is `red`, and exit 2 is `refused`; every unexpected exit is also a refusal, never a red verdict. The Foreman records the call and report in `events.jsonl`; this module only knows how to make the call. Streamed output is kept as a bounded tail while Inspector runs, and its stored report is capped at 16 KiB with the true total byte count, retaining the end where command-line tools normally print the diagnosis.

## The reviewer (`-vendor`/`-model`)

Inspector judges a change's *test* edits with a model of its own. When a
reviewer is configured, Fabrica names it on every call: `-vendor <v>
-model <m>`, with that vendor's `<VENDOR>_API_KEY` (and
`<VENDOR>_BASE_URL`, when set) placed on the Inspector child's
environment only - never in argv, which every process on the machine can
read out of the process table, and never in Fabrica's own environment.
Both flag names are ratified in `consumer-contract.json`, so renaming
one here without carrying it there fails `run.test.ts`, and the sync job
carries the change to Inspector's own copy.

The flags go on the call whenever a reviewer is configured, not only for
a project whose `.inspector.json` declares `testPaths`: `testPaths` is
what makes a reviewer *required*, not what makes one usable, and
Inspector ignores a reviewer it has nothing to judge.

Who the reviewer is, how it is configured, and the standing ruling that
it must never be the Worker's own vendor all live in
`src/reviewer/README.md`. That module is deliberately separate from this
one: settling a reviewer needs to know which vendor the Worker is, and
this module has no business depending on brains. It takes only the
`ResolvedReviewer` type from there, erased at compile time.

## The GitHub token (issue #103)

Inspector needs `GITHUB_TOKEN` to publish a green result. If Fabrica's own environment has it, it passes through. If not, the adapter runs `gh auth token` once and sets `GITHUB_TOKEN` in the inspector child's environment only. It never touches Fabrica's own process environment or the worker's box, and never prints or logs the token. If `gh` is missing or not logged in, `prepare()` throws, and the Foreman refuses the task (`inspector-not-ready`) before any worker starts, naming `gh auth login`. A new machine needs only "install, log in to GitHub, go" - no hand-added profile line.

## Which build of Inspector is installed

Fabrica and Inspector keep a ratified, hand-synced agreement about the call between them (`consumer-contract.json`), so updating one and leaving the other behind is how that agreement breaks. `doctor-checks.ts` is the one place that knows how the installed Inspector stands against its own `main`, and both callers reach that one answer - `inspectorVersionCheck`, which returns a `state` alongside the line it prints:

- **`fabrica doctor`'s inspector line** (`inspectorBranchStatus`) reports installed versus main inline, and `FAIL`s when Inspector is missing, cannot take `-branch`, or is behind - printing the exact `go install github.com/inactdev/inspector/cmd/inspector@<main's tip>` that fixes it. A stale Inspector therefore stops `fabrica up` (Client ruling). The version half is the only reason this line reports a version at all: Fabrica hands every green attempt to whatever `inspector` is on PATH, so a binary months behind main is a silently wrong verdict, not a missing feature.
- **`fabrica update`** installs that same commit for the two states where main's tip is strictly better than what is there - nothing installed, or `state: "behind"` - and leaves every other state alone. Nothing in that step can fail the update; see `src/cli/README.md`'s `fabrica update` section. Its own half of this module is `version.ts`: the three facts as one injectable `InspectorVersionProbes`, and `goInstallInspector`, the one action only that command takes. Everything it *reads* comes from here rather than a second copy.

Both branch on that same `state`, deliberately, rather than each deciding "behind" for itself: two classifiers for one question is how a line that says OK ends up describing a binary the other half just replaced.

### Three facts, three mechanisms

1. **What is installed:** `go version -m <the resolved binary>`'s `mod` line - read back out of the executable, so it describes what will actually run rather than whatever checkout sits on this machine. Its version is a Go pseudo-version whose last segment is a **12-character prefix** of the commit, which is why comparing it with a remote tip is a prefix comparison (`sameCommit`), never string equality. The grammar is ported from the Go toolchain's own `golang.org/x/mod/module` (`pseudo.go`'s `pseudoVersionRE`), not from prose about it - its three forms do not all separate the timestamp with `-`, which an eyeballed regex gets wrong. Also checked against a real toolchain rather than assumed: `go install <package>@<full sha>` is accepted and resolves to that same pseudo-version, so the printed fix really does land the commit it names.
2. **What main is:** `git ls-remote https://github.com/inactdev/inspector.git refs/heads/main` - one lightweight lookup per run that clones nothing and mutates no local ref, the same shape and reasoning as doctor's own "checkout" line uses against Fabrica's upstream. `main`, not `master`: Inspector's default branch differs from Fabrica's, so the two probes are deliberately separate rather than one shared helper.
3. **Which way round the two are:** a real ancestry answer (`ancestry.ts`). Two hashes only ever say "same" or "not the same", so `commitAncestry` fetches main's commit graph *without file contents* (`git fetch --filter=blob:none`, a quarter of a megabyte for this repository, measured) into a throwaway temp directory, asks `git merge-base --is-ancestor`, and deletes it. Nothing outside that temp directory is read or written. It is reached lazily - only once the two hashes already differ - so an Inspector that is current pays nothing for it, and `inspectorVersionCheck` takes it as a parameter so no test fetches anything.

**Why ancestry and not plain inequality** (Client ruling): a commit *ahead* of main, and one on a branch, are both different from main's tip without being stale. Calling "different" "behind" would report a deliberately hand-built Inspector as broken, and would make `fabrica update` install main's tip straight over it. `commitAncestry` is strict on purpose, too - git calls every commit its own ancestor, so the tip itself would otherwise come back "behind".

### What passes, and what it says

Everything but a genuinely stale install reports and passes, because a check that cannot tell must not guess:

- **A commit that is not behind main** - ahead of it, or on a branch of its own - says so, naming both commits.
- **A build from a checkout** (`go build` in a clone - Go stamps `vcs.revision` and `vcs.modified` for that and never for a module install) names its commit, says so if it was built with uncommitted changes, and passes whether or not it matches main. It may well be *ahead*, and `fabrica update` never installs over one.
- **A binary that records no commit** - a tagged release, or `-buildvcs=false` - names the module version it does record. Tags are never resolved to commits.
- **A binary nothing could read**: no Go toolchain on PATH (`go version -m` is the only reader of that record), a `go` that failed, or a binary built from some other module entirely.
- **An unreachable `origin main`, or an ancestry fetch that failed** - no network, no git - says so and never fails. A network outage is not a stale binary, and these two cases are worded apart because they fail at different points.

**`(devel)` is not the local-build tell it used to be.** Measured on a real machine (go1.26.8): a binary built from a *clean* local checkout carries a genuine pseudo-version naming the checkout's own commit, indistinguishable from a proxy install - so it is compared like any other, and an ancestry answer is what keeps it from being called stale. Only a *dirty* tree is distinguishable, by its `+dirty` version tag or its `vcs.modified=true` build setting, and `(devel)` now means only "built with no VCS directory at all".

Every probe here is injectable, so the default `npm test` run reads no real binary, asks GitHub nothing and fetches nothing: `doctor-checks.test.ts`'s fixtures are recorded from real `go version -m` output and its ancestry answers are handed in, while `ancestry.test.ts` runs real `git` against a real repository it creates.

This is unrelated to `consumer-contract.json`, which pins the *call* (flags, exit codes, the pull-request stdout line, the token env var) and says nothing about which build is installed.

## Publishing boundary

Fabrica commits the Worker's changes before this call, but never pushes them. Inspector owns publishing under [inspector#18](https://github.com/inactdev/inspector/issues/18): green work may be pushed by Inspector only after its independent check, and red work must remain local. Inspector repairs and commits mechanical failures that do not require the Client's request context before it reports green. Request-aware changes return as a red report for the Client's verdict instead.

A repository whose task base commit has no `.inspector.json`, or a machine where Inspector is not installed (`Inspector.installed()`), is self-tested in the Worker's own box instead - see `src/foreman/README.md`.

One publish needs more than the branch name: a fix round's host-side rebase rewrites the branch's commits (`src/foreman/fix-rebase.ts`), so publishing it is a *forced* push. `-expected-tip <sha>` is what that push may lease against - `origin/fabrica/<taskId>` as the fetch immediately before the rebase left it - so Inspector publishes with `--force-with-lease` instead of blind ([inspector#53](https://github.com/inactdev/inspector/issues/53)). The adapter passes the flag only when the caller has a tip to give, and never passes an empty one: a missing expected tip is "publish as before", not "lease against no branch". Which rounds have one, and why a round that rebased nothing deliberately has none, is `src/foreman/README.md`'s to say.
