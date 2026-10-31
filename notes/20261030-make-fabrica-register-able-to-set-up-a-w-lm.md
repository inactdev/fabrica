# `fabrica register --terms`: a work-mode project

## The plan, written before anything was touched

`--terms <folder>` is a third route through `registerProject`, beside
"full" (write, prove, push, pull request) and "registry-only" (origin is
already set up). It writes `.inspector.json`, `check.sh` and
`Dockerfile.inspector` into the folder the Client names, derives their
contents from the repository's own signals with the same `propose.ts`
code the printed proposal uses, touches the repository not at all, and
appends `terms` plus the no-stamp setting to the project's
`projects.toml` entry.

### The alternative that was rejected

Honouring `--check`/`--image` alongside `--terms`, so a work-mode
project could be set up with the Client's own command in one go. Two
reasons it was not built. The proving run those two flags exist for
(`./check.sh` inside `--image`) has nothing to run against on this
route: `check.sh` lands in the terms folder, not in the repository, and
there is no temporary worktree the two could be overlaid in - so
`--image` would be accepted and never pulled, which is exactly the
quiet, unproven setup "everything fails loudly" forbids. And the task
asks for the files to be proposed "from the repository's own signals
exactly as it does today", which is the derivation, not a command typed
on the command line. So the four flags that only make sense on the
repository route - `--check`, `--image`, `--timeout`, `--protected` -
are refused outright when `--terms` is given, rather than silently
ignored.

A second alternative, also rejected: creating the terms folder when it
is absent. `register` refuses instead, naming the `mkdir`. A `--terms`
typo would otherwise leave a stray folder holding three files and a
`projects.toml` entry pointing at it, which is precisely the quiet wrong
state this command's "everything that can refuse refuses first" order
exists to prevent.

## What a reader of this module should know

### Why the terms route skips four of `prepare`'s refusals

`gh`, the Docker daemon, a `fabrica/register` branch on origin and a
leftover local one are all prerequisites of *pushing*, and this route
pushes nothing, commits nothing and creates no branch. Requiring them
would refuse a work-mode setup on a machine that is perfectly able to do
it. What it still refuses on, unchanged: `<path>` being a git
repository's root, having an `origin` (a task's base commit is still cut
from origin's default branch), the project name being a usable
`projects.toml` key, and the project not already being registered.

### `.inspector.json`'s `check` is always `./check.sh` here

The printed proposal can name an indirect command (`npm test`, `go test
./...`), because it writes no `check.sh` for the Client. The terms route
does write one, so it keeps the module's standing rule instead - one
source of truth for the check - and puts the derived command inside
`check.sh`, with `.inspector.json` and `projects.toml` both naming
`./check.sh`.

### The one file that is deliberately not written

A repository that already carries its own `check.sh` at its root keeps
it: `.inspector.json`'s `./check.sh` is that file, and a second
`check.sh` in the terms folder would be a silent fork of it. Reported on
the result and printed, never skipped quietly. The other skip reason is
the Client's own ruling on this task - a file already in the terms
folder is kept and only what is missing is written.

A repository that names no command at all gets a `check.sh` that fails
with an explanation, never an empty or passing one: a stub that exits 0
would make every task on the project green for free.

### The settings this route writes are issue #316's own, not new ones

This branch was written while issue #316's reading half (`src/workmode/`,
`src/inspector/terms.ts`, `src/foreman/judge.ts`, `fabrica doctor`'s
per-project line) was not yet on `master`, so it named its own pair of
settings - `terms` and `stamp = false`. Rebasing onto `master` after
that half landed brought the ratified names: `terms` (same meaning, same
loader resolution against `projects.toml`'s own directory) and
`noStamp = true`, the inverted spelling of the same decision. There is
one setting per fact and one writer of it: `register` writes the entry,
`src/workmode/`'s `workModeFor` reads it on every round afterwards. Work
mode's third setting, `pullRequestTemplate`, is deliberately not written
here - whether a repository has its own
`.github/PULL_REQUEST_TEMPLATE.md` is not something the two arguments
this command is given could answer.

A consequence worth keeping: `registerSummary`'s tail is about what the
settings *do* from the next task onwards, not about a gap. The one real
limit left on this route is that it proves nothing, so a
`REPLACE-ME-with-...` still in one of the three files surfaces as the
next task's refusal.

### The same shape elsewhere, left standing

`--protected` is already silently ignored on the printed-proposal route
(`proposeInspectorConfig` never sees `request.protectedPaths`). That is
pre-existing and was not changed here, since nothing is written on that
route for the flag to have been wrong about; it is named here so it is
known rather than missed.
