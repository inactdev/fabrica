# Inspector handoff

`src/inspector/` is Fabrica's adapter for the independently run `inspector` command. A task requires inspection when its base commit contains `.inspector.json`; Worker changes cannot opt out or weaken inspection by changing it. Any final config blob that differs from the base commit, including deletion, is an Inspector refusal rather than a skip. The adapter turns Inspector's exit codes into `green`, `red`, or `refused` without treating a refusal as a red verdict.

The handoff is trigger-driven: after each attempt's work is committed, the Foreman invokes Inspector directly and waits for that process. Fabrica runs no check of its own (issue #64); Inspector's run is the verdict, and a red report becomes the next attempt's correction brief. The call is `inspector -repo <worktree> -branch fabrica/<taskId>`: Inspector requires `-branch`, the one branch it may publish to after a green result. Neither module polls for an Inspector result. Exit 0 is `green`, exit 1 is `red`, and exit 2 is `refused`; every unexpected exit is also a refusal, never a red verdict. The Foreman records the call and report in `events.jsonl`; this module only knows how to make the call. Streamed output is kept as a bounded tail while Inspector runs, and its stored report is capped at 16 KiB with the true total byte count, retaining the end where command-line tools normally print the diagnosis.

## The GitHub token (issue #103)

Inspector needs `GITHUB_TOKEN` to publish a green result. If Fabrica's own environment has it, it passes through. If not, the adapter runs `gh auth token` once and sets `GITHUB_TOKEN` in the inspector child's environment only. It never touches Fabrica's own process environment or the worker's box, and never prints or logs the token. If `gh` is missing or not logged in, `prepare()` throws, and the Foreman refuses the task (`inspector-not-ready`) before any worker starts, naming `gh auth login`. A new machine needs only "install, log in to GitHub, go" - no hand-added profile line.

## The doctor line

`doctor-checks.ts` owns `fabrica doctor`'s one `inspector` line: on PATH, takes `-branch`, and built from the commit Inspector's own `origin main` is at. The last of those three is the only reason it reports a version at all - Fabrica hands every green attempt to whatever `inspector` is on PATH, so a binary months behind main is a silently wrong verdict, not a missing feature. The comparison is the module commit the binary itself records (`go version -m <the resolved binary>`, read back out of the executable, so it describes what will actually run rather than whatever checkout sits on this machine) against `git ls-remote https://github.com/inactdev/inspector.git refs/heads/main` - one lookup per `doctor` run, no clone either side and no local ref mutated, the same shape and reasoning as doctor's own "checkout" line uses against Fabrica's upstream. Inspector's default branch is `main` and Fabrica's is `master`, so the two probes are deliberately separate rather than one shared helper.

Exactly one case fails: a binary installed from a resolved module version (`go install <package>@<anything>`) whose commit is not main's tip. That is behind, and the `fix:` is `go install github.com/inactdev/inspector/cmd/inspector@<main's sha>` - pinned to the sha just compared against, not `@latest`, so what lands is the commit the line named. `fabrica up` stops on any doctor FAIL, which is the point: a session should not start against a stale judge.

Everything else reports and passes, because nothing here can order two commits without a clone, and a check that spends nothing must not guess:

- **A build from a checkout** (`go build` in a clone - Go stamps `vcs.revision` and `vcs.modified` for that and never for a module install) names its commit, says so if it was built with uncommitted changes, and passes whether or not it matches main. It may well be *ahead*.
- **A binary that records no commit** - a tagged release, or `-buildvcs=false` - names the module version it does record.
- **A binary nothing could read**: no Go toolchain on PATH (`go version -m` is the only reader of that record), a `go` that failed, or a binary built from some other module entirely.
- **An unreachable `origin main`** - no network, no git - says "could not check origin main" and never fails. A network outage is not a stale binary.

Two Go facts this rests on, both checked against a real toolchain (a real `go install ...@latest`, a real `go build` in a clone, and a real install of an older commit) rather than assumed: a module install's `mod` line carries a pseudo-version whose last field is the commit abbreviated to 12 characters (so comparing it against a full 40-character sha is a prefix comparison), and `go install <package>@<full sha>` is accepted and resolves to that same pseudo-version. The pseudo-version pattern itself is Go's own `pseudoVersionRE`, copied from the toolchain's source - its three forms do not all separate the timestamp with `-`, which an eyeballed regex gets wrong.

This is unrelated to `consumer-contract.json`, which pins the *call* (flags, exit codes, the pull-request stdout line, the token env var) and says nothing about which build is installed.

## Publishing boundary

Fabrica commits the Worker's changes before this call, but never pushes them. Inspector owns publishing under [inspector#18](https://github.com/inactdev/inspector/issues/18): green work may be pushed by Inspector only after its independent check, and red work must remain local. Inspector repairs and commits mechanical failures that do not require the Client's request context before it reports green. Request-aware changes return as a red report for the Client's verdict instead.

A repository whose task base commit has no `.inspector.json`, or a machine where Inspector is not installed (`Inspector.installed()`), is self-tested in the Worker's own box instead - see `src/foreman/README.md`.

One publish needs more than the branch name: a fix round's host-side rebase rewrites the branch's commits (`src/foreman/fix-rebase.ts`), so publishing it is a *forced* push. `-expected-tip <sha>` is what that push may lease against - `origin/fabrica/<taskId>` as the fetch immediately before the rebase left it - so Inspector publishes with `--force-with-lease` instead of blind ([inspector#53](https://github.com/inactdev/inspector/issues/53)). The adapter passes the flag only when the caller has a tip to give, and never passes an empty one: a missing expected tip is "publish as before", not "lease against no branch". Which rounds have one, and why a round that rebased nothing deliberately has none, is `src/foreman/README.md`'s to say.
