# Setting a project up (`fabrica register`)

`src/register/` is `fabrica register <path>`: it makes a repository
checkable, and adds it to `projects.toml`. `src/cli/register-command.ts`
is only the CLI layer over it — parse, call, report.

## Why this is the one command allowed to push

Everything else in Fabrica is forbidden to push, and `src/inspector/
README.md`'s "Publishing boundary" says why: a Worker's work must not
reach a remote until something independent has judged it.

This command is not an exception to that rule; it falls outside it. It
runs as the Client, on the Client's own machine, with his own git
credentials, and nothing a Worker produced passes through it at all —
the two files it commits are generated here from his own `--check` and
`--image`. The only thing it ever puts on origin is one new branch,
`fabrica/register`, for him to merge:

- never a merge, and never a push to any branch but that one;
- never `--force`, and never over an existing branch — a
  `fabrica/register` already on origin is a refusal, not something to
  overwrite;
- never inside a worker, and never from a detached process.

## The order is the design

Everything that can refuse refuses while the only thing that has
happened is reading. A missing `gh`, a stopped Docker daemon, a branch
that already exists, a project already registered — each costs the
Client nothing but the message, and each message ends with "Nothing was
changed," because nothing was.

Only once all of that has passed does anything get created, and from
there every failure path unwinds what it made:

1. `<path>` is an existing git repository's root, with an `origin`.
2. `gh` is installed, and logged in to **origin's own host**.
3. The Docker daemon is reachable.
4. origin is readable (which is also the proof there is a clean path to
   push) and has no `fabrica/register` branch.
5. No leftover local `fabrica/register` branch either.
6. The project name is a usable `projects.toml` key, and neither it nor
   this repository's path is registered already.
7. Does origin's default branch already carry `.inspector.json`? If so
   the repository side is done — skip to step 11.
8. A temporary worktree of origin's default branch, on
   `fabrica/register`.
9. Write `.inspector.json` and `check.sh`; run `./check.sh` inside
   `--image`. A failure refuses here, with the check's own output.
10. Commit, push, `gh pr create`.
11. Append `[projects.<name>]` to `projects.toml`.

`projects.toml` is written **last**, so the registry only ever gains an
entry once the repository side actually happened.

## Why origin's default branch, never the local checkout

A task's base commit is cut from origin's default branch
(`src/line/cut.ts`), never from whatever the Client last had checked
out. So "is this project set up for Fabrica" is a question about
origin's default branch, and `inspectorConfiguredOnOrigin` asks it
there — `fetchOriginDefaultBranch` (exported from `src/line/` for
exactly this, so the two sides cannot come to disagree about what a
task's base commit is), then `git ls-tree` against `origin/<branch>`.

Answering from local `HEAD` would be cheaper — no fetch — and wrong for
the same reason `createProductionLine` refuses to cut a line from the
local checkout.

`inspectorConfiguredOnOrigin` returns `boolean | null`, and the `null`
matters: it means the question could not be answered (no origin, an
unreachable one). `fabrica do` turns `false` into "this project isn't
set up for Fabrica yet," and saying that to someone whose network is
down would be both wrong and less use than the real git error that
follows. `null` is therefore not folded into `false`.

## Never on the host

The check runs inside `--image`, through `src/containment/` — the same
place a Worker's own check box runs, with the same read-only git mounts
and a sanitized, credential-free `config` shadowed over the real one.
Issue #64's ruling ("Fabrica runs no project check on the host") binds
this command exactly as it binds the Foreman, and the Client ruling on
this one said so again directly.

A box that could not start at all is reported separately from a check
that ran and failed (`BoxCheckResult`'s own distinction): neither one
registers anything, but only the second is a statement about the check.

## Proposing an `.inspector.json` instead of demanding one (issue #114)

Writing `.inspector.json` by hand means knowing Inspector's schema and
the protected-path trap. So a repository that needs setting up, run
without `--check` and `--image`, gets a **proposal** — step 7 above,
where the old "that needs `--check` and `--image`" refusal used to be:

    fabrica register <path> > <path>/.inspector.json

`src/register/propose.ts` derives it from three signals, read off
**origin's default branch** (never the working tree — the same ref step 7
just asked the `.inspector.json` question against, and the ref a task's
base commit is cut from): an existing `check.sh`, `package.json`'s
`scripts`/`engines`/dependencies, and `go.mod`. Reading is one function,
deriving is a pure one over the three strings it read, so every rule
below is tested with no repository at all.

It **prints the proposal and never writes it** — the issue's own words. A
tool that quietly writes the file defining how its own work is judged is
the off-the-books edit this project exists to prevent, so the Client keeps
the pen. The two streams are the contract (Client ruling, issue #114's
clarification):

- **stdout: the JSON document, alone.** One `console.log`, so the
  redirect above yields a file ending in exactly one newline.
- **stderr: every field's reasoning, one line per field** — including
  `network`'s, which JSON itself has nowhere to put — plus any
  disagreement between two signals.

It is still a **refusal**: exit 1, nothing written, nothing registered,
nothing pushed (`RegisterProposalError`, the one refusal carrying data
alongside its message). So `fabrica register <path> && fabrica do ...`
cannot read a proposal as a successful registration.

### How each field is derived

- **`check`** — an existing `check.sh` wins over everything, and any
  signal it contradicts is **named** on stderr rather than dropped (the
  Client's ruling on question 3). Otherwise `package.json`'s `test`
  script makes it `npm test`, a `go.mod` makes it `go test ./...`, and a
  repository naming no command at all is told to write `check.sh`.
- **`image`** — the only declaration-to-image pairing there is live
  evidence for is an exactly-pinned `engines.node` against
  `cimg/node:<version>`, which is this repository's own `.inspector.json`.
  Everything else gets `REPLACE-ME-with-...`, not a guess: a version
  *range* names no single tag, and `go.mod`'s toolchain version has no
  in-repo precedent for a Go image. The placeholder carries uppercase on
  purpose — a Docker repository name must be lowercase, so it is an
  *invalid* reference and fails loudly on the first pull instead of
  resolving to something plausible.
- **`network`** — on only when the check's own text names a dependency
  installer (`npm ci`, `pip install`, `go mod download`, ...), since
  fetching is the only thing network access buys. Declared dependencies
  with *no* install step are named on stderr instead of answered with a
  `true` that would not help: `npm test` with no `npm ci` in front of it
  fails in a fresh box for want of `node_modules` whether the network is
  there or not.
- **`timeoutSeconds`** — always omitted, and the line says why. Nothing
  in a `package.json`, a `go.mod` or a `check.sh` says how long a check
  takes, and the invented number would be the one deciding whether a real
  check is killed mid-run. (A CI workflow's `timeout-minutes:` is the one
  real signal in a repository and is deliberately not read: workflow
  files aren't among the signals issue #114 names, and this repository
  ships no YAML parser.)
- **`protectedPaths`** — a file-path check (`./check.sh`) is listed; an
  indirect one lists nothing and says the decision is the Client's, since
  which file freezing `npm test` means (the script, the `package.json`
  holding it, the lockfile, all three) is a judgment about his
  repository. `.inspector.json` and the CI workflow files are **never**
  listed: the gate protects those on its own.

That last point is a deliberate disagreement with `protectedPathsFor`
below, which always lists `.inspector.json` next to `check.sh`. Two
different authorities, not a bug in either — if they should ever agree,
`protectedPathsFor` is the one to change, under a ruling.

### Why the proposal lands where it does

After `prepare()`'s whole refusal cascade, not before it. Building it in
the CLI layer first would be friendlier to someone whose `gh` login is
stale (a proposal needs no `gh` and no Docker), and it would also answer
"this project is already registered" with a config proposal he cannot
use. Refusals first, proposal last.

## `.inspector.json`'s schema, and where it came from

Up to five keys: `check` (always `./check.sh`), `image`,
`protectedPaths`, and — only when asked for — `network` and
`timeoutSeconds`.

Inspector's own documentation was **not reachable** when this was
written, so the schema was taken from the only authoritative evidence
in reach: this repository's own `/.inspector.json`, a live config the
real Inspector acts on in this repo's CI, plus
`contract/helpers/fixture.ts`'s `FIXTURE_INSPECTOR_CONFIG`, which
proves the minimal `check` + `image` form is valid.
`scaffold.test.ts` pins that provenance — it fails if a key is written
that this repository's own config doesn't use. A sixth key should not
be added here on a guess; read Inspector's docs first.

`check.sh` and `.inspector.json` are **always** in `protectedPaths`,
with `--protected` adding to them rather than replacing them: a setup
that protected the check but not the file naming the check would
protect nothing, which is CONTRACT rule 9's whole subject.

## `--network` and `--timeout`

Both describe the box **Inspector** will run the check in later, and
both only ever land in `.inspector.json`:

- `--network` writes `network: true`. A check that fetches anything —
  `npm ci` against the registry, `pip install` into a virtualenv — cannot
  pass in a box with no network, and that is a common enough shape to
  need a flag rather than a hand-edit after the fact. (A check that
  installs a *system* package is a different problem, and this flag is
  not its answer: see the testing section below.)
- `--timeout <seconds>` writes `timeoutSeconds`.

"Off" is the **absence** of the key, not `network: false` or
`timeoutSeconds: 0`. Neither of those spellings appears in any live
config in reach, and the rule above — only write keys and values some
working config actually shows — applies to values as much as to names.
Leaving a key out leaves Inspector's own default in place, which is
what "default off" means here.

Neither flag changes the one proving run `register` itself does.
`tools.ts`'s `realRunCheck` has always passed `network: "allowed"`, for
the same reason a worker's own check box does: a real check installs its
project-local dependencies (`npm ci`, a virtualenv), which it can,
because those land in the bind-mounted workdir it owns. Gating that run behind `--network` would make a check
that is about to be green on Inspector refuse here as **red**, which is
the one outcome this command must never produce. `--timeout` has
nothing to bind to on this side at all — `RunContainedOptions` has no
timeout.

The honest cost of that choice, stated rather than hidden: a check that
needs the network and was registered *without* `--network` passes here
and fails later, under Inspector. The alternative trade — refusing a
good check because this run denied it something Inspector would have
allowed — is worse, since it blocks setup outright instead of producing
a red first task with a legible reason. HANDBOOK.md's case 8 tells the
chat agent to pass `--network` whenever the CI check it copied installs
anything of its own, which is where the choice is actually made.

## One source of truth for the check

`projects.toml`'s `check` is always `./check.sh` — not the `--check`
command verbatim — in both the full and the shortcut case. `check.sh`
holds the command, `.inspector.json` names `./check.sh`, and
`projects.toml` names `./check.sh`. Recording the raw command instead
would mean an edit to `check.sh` silently left `projects.toml`
describing a command nothing runs any more.

## `gh`, read from its manual

Two documented facts this module is built on, both from gh's current
manual rather than from memory:

- **`gh auth status` exits 1 when *any* stored account on *any* host
  has a problem.** A stale GitHub Enterprise token would otherwise make
  a perfectly good GitHub login read as "not logged in", so the check
  is always scoped with `--hostname <host from origin's URL>`
  (`hostFromOriginUrl` handles the scp-style form too, which is not a
  URL).
- **`gh pr create` prints the new pull request's URL to stdout, and can
  exit non-zero having already printed it.** So a URL in the output
  wins over the exit code — refusing on the status alone would tell the
  Client nothing was opened when something was. `--title` +
  `--body-file` + `--base` + `--head` together are what make the call
  non-interactive; `--head` in particular is what stops gh offering to
  push or fork the branch itself, which it must never do here.

## What is torn down, and what is deliberately left

On **any** path, the temporary worktree is removed (`finally`). The
Client's own checkout is only ever read — `register.test.ts` proves it
with the same `fingerprint()` ruler CONTRACT rule 1 uses.

The local `fabrica/register` branch is deleted **only when nothing was
pushed**, so a retry with a corrected `--check` isn't blocked by the
wreckage of the previous attempt. After a successful push it is left
alone: it is on origin, and deleting a branch the Client may want is not
this command's call.

## projects.toml is appended to, never rewritten

`registry-write.ts` appends text rather than re-serializing the parsed
config. `projects.toml` is the Client's own file — his comments, his key
order, his `[caps]` — and a round-trip through a TOML writer would
quietly rewrite all of it to register one project. A new table header at
the end is always valid TOML regardless of what came before.

Every write is read back through the real loader and rolled back to the
exact prior bytes if it no longer parses. The Client's registry must
never be left unreadable by a command he ran to add one line to it.

## Testing it without `gh`, Docker, or a network

`tools.ts` is the seam: `ghStatus`, `dockerStatus`, `runCheck`,
`openPullRequest` — the four things that reach outside this machine.
`helpers/fake-register-tools.ts` stands in for exactly those, and
nothing else. Git stays real throughout: a real `git worktree add`, a
real commit, a real push to the fixture's own bare origin
(`contract/helpers/fixture.ts`'s `addOrigin`), a real teardown, a real
`projects.toml` write — the same "real git against a throwaway
repository" convention `src/line`'s own tests use.

The fake's `runCheck` reads the `check.sh` register just wrote and
honors what it says, so `--check "exit 3"` is genuinely red and
`--check "exit 0"` genuinely green, with no container involved.

`tools.test.ts` is the other half: the real containerized run, skipping
(never failing) without a Docker daemon, and genuinely executed by
`.github/workflows/docker-tests.yml`. It uses two images, for two
reasons.

Plain `alpine` for the red-vs-green assertions — the image
`FIXTURE_INSPECTOR_CONFIG` names, and deliberately not one with its own
entrypoint: `runContained` passes the command straight after the image
name with no `--entrypoint` override, so an image whose entrypoint is a
program (`alpine/git`'s is `git`) would run `git sh -c ./check.sh` and
fail for a reason that has nothing to do with the check.
`src/line/worktree-git.test.ts` can use `alpine/git` because it passes
git *subcommands* as the command.

`cimg/base:2025.10` for the one assertion that needs git present,
because **nothing can be installed inside a check box**: `runContained`
runs every container as the host `uid:gid` (`src/containment/run.ts`'s
`--user`), and a package manager cannot write to `/var`, `/etc` or
`/usr` as an unknown user with no sudo. That is the containment design
holding rather than a gap — a root container's writes into the bind
mount would come out root-owned on the host. So the assertion uses an
image that already ships git. `cimg/base` has no `ENTRYPOINT`, runs a
normal user that `--user` overrides, and ships git from the git-core
PPA; it is also the image the first real registration will use, so the
assertion doubles as proof of that path.

That last fact has a consequence for the Client, not just for this
test: a check that installs a system package (`apt-get install
shellcheck`) cannot pass `register`'s proving run either, network or
no network, and `register` will refuse with the check's own output.
Name an `--image` that already ships what the check needs — which is
also what stops the later Inspector run depending on a package
repository being up.
