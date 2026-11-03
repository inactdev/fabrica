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
the three files it commits are generated here from his own `--check` and
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
9. Write `.inspector.json`, `check.sh` and `Dockerfile.inspector` —
   never over a committed `Dockerfile.inspector`, which is left exactly
   as it is; run `./check.sh` inside `--image`. A failure refuses here,
   with the check's own output.
10. Commit, push, `gh pr create`.
11. Append `[projects.<name>]` to `projects.toml`.

`projects.toml` is written **last**, so the registry only ever gains an
entry once the repository side actually happened.

A work-mode registration (`--terms <folder>`, below) replaces steps 2,
3, 4, 5, 8, 9 and 10 with one: write the three files into that folder.
Steps 1, 6, 7 and 11 are unchanged.

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

`src/register/propose.ts` derives it from the signals it can read off
**origin's default branch** (never the working tree — the same ref step 7
just asked the `.inspector.json` question against, and the ref a task's
base commit is cut from): an existing `check.sh`, `package.json`'s
`scripts`/`engines`/dependencies, `go.mod`, whether a
`package-lock.json` or a `go.sum` is there, and — issue #324 — a
`Gemfile.lock`'s own contents, the `Gemfile`, `.ruby-version` and
whether `bin/rails` is there. Reading is one function, deriving is a
pure one over what it read, so every rule below is tested with no
repository at all.

Since inspector#47 (issue #303) the proposal is **two files**: the config
names no image and no network any more, so the `Dockerfile.inspector` the
check box is built from is proposed alongside it. For the one shape whose
check cannot be named as a bare command it is **three** — see "The Ruby
shape" below.

It **prints the proposal and never writes it** — the issue's own words. A
tool that quietly writes the file defining how its own work is judged is
the off-the-books edit this project exists to prevent, so the Client keeps
the pen. The two streams are the contract (Client ruling, issue #114's
clarification):

- **stdout: the JSON document, alone.** One `console.log`, so the
  redirect above yields a file ending in exactly one newline.
- **stderr: every field's reasoning, one line per field** — plus any
  disagreement between two signals, the one warning below, and the
  proposed `Dockerfile.inspector` itself. That file is deliberately
  **not** on stdout: a second document there would corrupt the one the
  redirect writes.

It is still a **refusal**: exit 1, nothing written, nothing registered,
nothing pushed (`RegisterProposalError`, the one refusal carrying data
alongside its message). So `fabrica register <path> && fabrica do ...`
cannot read a proposal as a successful registration.

### How each field is derived

- **`check`** — an existing `check.sh` wins over everything, and any
  signal it contradicts is **named** on stderr rather than dropped (the
  Client's ruling on question 3). Otherwise a `Gemfile.lock`'s own suite
  wins (below), then `package.json`'s `test` script makes it `npm test`,
  a `go.mod` makes it `go test ./...`, and a repository naming no command
  at all is told to write `check.sh`.
- **`Dockerfile.inspector`'s `FROM`** — the only declaration-to-image
  pairing there is live evidence for is an exactly-pinned `engines.node`
  against `cimg/node:<version>`, which is this repository's own
  `Dockerfile.inspector`. Everything else gets `REPLACE-ME-with-...`, not
  a guess: a version *range* names no single tag, and `go.mod`'s
  toolchain version has no in-repo precedent for a Go image. The
  placeholder carries uppercase on purpose — a Docker repository name
  must be lowercase, so it is an *invalid* reference and fails loudly on
  the first build instead of resolving to something plausible.
- **`Dockerfile.inspector`'s install step** — what the retired `network`
  key used to stand in for. A `package-lock.json` becomes `npm ci`, a
  `go.sum` becomes `go mod download`, and anything else becomes a
  **comment in the file** naming what still has to be installed there:
  declared dependencies with no lockfile, or a shape nothing here knows,
  are said out loud rather than answered with an invented install step.
  A check whose own text names an installer (`npm ci`, `pip install`,
  ...) additionally gets a `warning:` line, because that step cannot
  succeed at all in a box with no network — it is about the check, not
  about anything the proposal writes.
- **`timeoutSeconds`** — omitted, and the line says why. Nothing
  in a `package.json`, a `go.mod` or a `check.sh` says how long a check
  takes, and the invented number would be the one deciding whether a real
  check is killed mid-run. (A CI workflow's `timeout-minutes:` is the one
  real signal in a repository and is deliberately not read: workflow
  files aren't among the signals issue #114 names, and this repository
  ships no YAML parser.) The **one exception** is a check that boots its
  own servers (the Ruby shape below): 30 minutes, by Client ruling on
  issue #324, because that check is in a different order of magnitude
  from `go test ./...` and leaving Inspector's own default to decide
  would be leaving a real suite to be killed mid-run. The line says it is
  a ceiling rather than a measurement, and to set it to what one real run
  actually takes.
- **`protectedPaths`** — a file-path check (`./check.sh`) is listed; an
  indirect one lists nothing and says the decision is the Client's, since
  which file freezing `npm test` means (the script, the `package.json`
  holding it, the lockfile, all three) is a judgment about his
  repository. `.inspector.json` and the CI workflow files are **never**
  listed: the gate protects those on its own.

That last point is a deliberate disagreement with `protectedPathsFor`
below, which always lists `.inspector.json` and `Dockerfile.inspector`
next to `check.sh`. Two different authorities, not a bug in either — if
they should ever agree, `protectedPathsFor` is the one to change, under a
ruling.

### Why the proposal lands where it does

After `prepare()`'s whole refusal cascade, not before it. Building it in
the CLI layer first would be friendlier to someone whose `gh` login is
stale (a proposal needs no `gh` and no Docker), and it would also answer
"this project is already registered" with a config proposal he cannot
use. Refusals first, proposal last.

## Work mode: `--terms <folder>`, for a repository that can carry none of this

At a day job the three files that say how work is judged cannot be
committed to the company's repository at all. There is no pull request
to open for them. So `--terms <folder>` writes them into a folder of the
Client's own instead, and `projects.toml` records where (`terms`) plus
`noStamp = true` — two of issue #316's three work-mode settings, beside
issue #314's `githubTokenVar` and issue #331's `githubToken = "gh"`
(`src/projecttoken/`). Both are read, on
every round, by `src/workmode/`; this command is the one place that
writes them. The third, `pullRequestTemplate`, is the Client's own
choice per repository and is not written here.

`terms.ts` is that route. Its three properties, and they are the whole
of it:

- **The repository is not touched.** No worktree, no commit, no branch,
  no push, no pull request. `terms.test.ts` proves it with the same
  `fingerprint()` ruler CONTRACT rule 1 uses, and asserts none of the
  four faked outside things was reached.
- **The contents are derived, not invented.** `propose.ts`'s
  `deriveProposal` is the same code, over the same signals, read off the
  same ref (origin's default branch) as the proposal `register` prints.
  There is no second set of rules for a work-mode project — which is
  what `propose.test.ts`'s "the printed proposal is built from exactly
  what it returns" pins.
- **Nothing already in the folder is overwritten** (Client ruling on
  this task: "keep existing files, write only what's missing"). Each
  write is a `wx` open, so "already there" is the filesystem's own
  answer rather than a question asked before a write that could race it.
  So a folder the Client has edited by hand survives a second run byte
  for byte.

### The four prerequisites it skips, and why

`gh`, the Docker daemon, a `fabrica/register` branch on origin and a
leftover local one are all prerequisites of *pushing*. This route
pushes nothing, so refusing it for a logged-out `gh` or a stopped Docker
daemon would refuse a setup the machine is perfectly able to do. What
still refuses, unchanged: `<path>` being a git repository's root with an
`origin` (a task's base commit is still cut from origin's default
branch), the name being a usable `projects.toml` key, and the project
not already being registered.

In their place, three refusals of its own, all of them reads:
`--terms` naming something that is not an existing folder
(`terms-unusable` — it is never created for you, so a typo cannot
quietly become a registered project's terms folder); naming a folder
*inside* the repository (`terms-inside-repo` — there, the terms are in
every Worker's own checkout, editable by the very task they judge); and
a repository that already carries `.inspector.json` on origin's default
branch (`terms-not-needed` — its terms are in it, and a second set
beside them could only disagree).

### Why it refuses `--check`, `--image`, `--timeout` and `--protected`

Those four describe the route that writes into the repository.
`--image` exists to be pulled by the one proving run, and this route has
nothing to run it against: `check.sh` lands in the terms folder, not in
a worktree of the repository. `--timeout` and `--protected` are derived
here the way a proposal derives them. Accepting any of them and ignoring
it is the silent skip the standing rulings forbid, so the combination is
a refusal naming both flags — in `register.ts`, not in the argument
parser, because `registerProject` is also a library entry point and one
implementation is what keeps the two from disagreeing.

### `.inspector.json` names a script here, whatever the signals said

The printed proposal can name an indirect command (`npm test`), because
it writes no script for that command to live in. This route does write
one, so it keeps "One source of truth for the check" below instead: the
derived command goes inside `check.sh`, and the config names that
script.

**Which spelling of the script, though, is not the same on both routes**
(issue #337). Inspector mounts a terms folder read-only at `/terms`,
keeps the repository at `/workspace`, and runs the check from there — so
`./check.sh` in a terms folder's config names `/workspace/check.sh`, a
file a work-mode repository does not have and may never be given. The
config written here names `sh /terms/check.sh` instead
(`checkCommandFor`, `TERMS_RECORDED_CHECK`).

The one exception is the one file deliberately not written: a repository
that already carries its own `check.sh` at its root keeps it, no second
one goes into the terms folder — a copy would be a silent fork of it —
and the config then names `./check.sh`, because that repository's own
script really is at `/workspace/check.sh`. Which of the two spellings
goes in follows that one question, and nothing else. Reported on the
result and printed, never skipped quietly. A repository naming no
command at all gets a `check.sh` that **fails** with an explanation and
the usual `REPLACE-ME-with-...` marker; a stub exiting 0 would make
every task on the project green for free.

`projects.toml` still records `./check.sh` on both routes: that field is
what a worker's own box would run if no Inspector were installed, from
inside the checkout, and is not what Inspector reads.

### The other two files differ too, for the same reason (issue #337)

- **`check.sh` does not `cd "$(dirname "$0")"`.** In the repository that
  line is right — the script's own folder *is* the repository root. From
  a terms folder it lands in `/terms`, where there is no checkout and no
  suite. Inspector already runs the check from `/workspace`, so the fix
  is to drop the line, and the script says so where it used to be.
- **`Dockerfile.inspector` copies with `COPY --from=repo`.** Inspector
  resolves the `docker build` context against the terms folder, which
  holds no `Gemfile` and no `package-lock.json` — a plain `COPY` there
  fails the build on files that are not missing from the repository at
  all. `repo` is the named build context Inspector hands every build the
  repository as (inspector#81), and the only way to reach it from a
  terms folder. The in-repository route keeps the plain `COPY`
  deliberately: its build context genuinely is the repository, so it
  needs no dependency on that feature.

### A folder written before all of that

Nothing here overwrites a file already in the folder, so a folder
written before issue #337 keeps three files that cannot pass a real
Inspector run. `oldShapeProblem` asks one question of each kept file —
does the config name a path outside `/terms`, does the script `cd` to
its own folder, does the Dockerfile `COPY` without a `--from` — and a
yes becomes the `kept-old-shape` outcome, whose detail says what
Inspector does with the file and how to replace it. Still kept, never
rewritten; `registerSummary` repeats it as its own sentence at the end,
because "left exactly as it is" among two files that were written reads
as a success.

It is deliberately conservative: one fact per file, never a diff against
what this route writes today. A Client who has edited his own terms must
not be told they are "the old shape" because a comment moved.

### What `--terms` does not do

- **It proves nothing.** The repository route runs `./check.sh` inside
  `--image` before it pushes, and can, because it has a worktree and an
  image the Client named. Here the `FROM` line is usually still a
  placeholder, so there is nothing to run and nothing is claimed. The
  summary says so on stdout.
- **It finishes nothing.** The two settings it records are read from the
  next task onwards — `fabrica do` asks `termsSetup` about the folder
  instead of `originSetup` about the repository, and a round hands
  Inspector `-terms` (`src/workmode/`, `src/inspector/terms.ts`,
  `src/foreman/judge.ts`) — but a `REPLACE-ME-with-...` still in one of
  the three files is a refusal at that task, which this route cannot
  pre-empt because it runs nothing. `registerSummary` says so in the
  same breath as the registration rather than leaving the Client to meet
  it as a refusal.
- **It writes no `pullRequestTemplate`.** Work mode's third setting says
  the repository's own `.github/PULL_REQUEST_TEMPLATE.md` is the shape
  of the pull request body — a fact about that repository, not something
  this command could read off the two it was given.

## `.inspector.json`'s schema, and where it came from

Up to three keys: `check` (the project's own script — `./check.sh`, or
`sh /terms/check.sh` from a terms folder, see work mode above),
`protectedPaths`, and — only when asked for — `timeoutSeconds`.

There used to be two more, `image` and `network`. **inspector#47
(inspector PR #64) retired both, with any value**: the check box is
built from a `Dockerfile.inspector` committed at the repository root,
and that box has no network at all. `register` wrote them until issue
#303, which meant every project registered in between was refused on its
first task.

Inspector's own documentation was **not reachable** when this was
written, so the schema was taken from the only authoritative evidence in
reach: this repository's own `/.inspector.json`, a live config the real
Inspector acts on in this repo's CI. `scaffold.test.ts` pins that
provenance — it fails if a key is written that this repository's own
config doesn't use, which is exactly how the two retired keys were
caught. A fourth key should not be added here on a guess; read
Inspector's docs first. (`contract/helpers/fixture.ts`'s
`FIXTURE_INSPECTOR_CONFIG` still carries an `image` key. It is a fixture
no real Inspector ever reads — every test faking the check box or
Inspector supplies its own answer — so it is evidence of nothing about
the schema any more.)

`check.sh`, `.inspector.json` and `Dockerfile.inspector` are **always**
in `protectedPaths`, with `--protected` adding to them rather than
replacing them: a setup that protected the check but not the file naming
the check, or not the image the check runs in, would protect nothing,
which is CONTRACT rule 9's whole subject. (`Dockerfile.inspector` joined
that list with issue #303's clarification, matching what this
repository's own config now protects.)

## `Dockerfile.inspector`, and why `/deps`

`dockerfile.ts` writes it. `--image` goes on the `FROM` line, with
where that image came from as the file's own comment — a Dockerfile has
somewhere to put reasoning, which is the one thing `.inspector.json`
never had.

**The check container has no network**, so a project's own dependencies
are installed in this file, at build time. Three shapes are recognized:
a `package-lock.json` (`npm ci`) and a `go.sum` (`go mod download`),
both named by issue #303 itself, and a `Gemfile.lock` (`bundle install`,
issue #324 — see below). Anything else — declared dependencies with
no lockfile, a `requirements.txt`, a system package — gets a **comment
in the file** naming what still has to be installed there. Never a
silent gap, and never an invented install step.

`Gemfile.lock` is asked **first** when a repository carries more than
one: that repository is a Rails application with a JavaScript bundler,
whose suite is still the Ruby one. Between the other two,
`package-lock.json` wins for no deeper reason than that one answer has
to be picked. Either way the Dockerfile says which it took, and a
lockfile that went uninstalled is named in the notes.

They go in `/deps`, not beside the checkout, because **Inspector puts
the repository's own files in place when it runs the check**: anything
installed at the checkout's path at build time is shadowed by them. So
the npm shape has a second half, in `check.sh`: link
`/deps/node_modules` in when it is there, and install for real when it
is not (a laptop, a worker's own box, `register`'s own proving run). That
pair — the `/deps` install and the link — is this repository's own
`Dockerfile.inspector` and `check.sh` (PR #302), the only live evidence
of a check image that actually builds and passes. A Go module needs no
link: its module cache lives in the image, outside the checkout, where
`go test` already looks.

The npm step carries one caveat in the file itself, since the build is
where it bites: `npm ci` runs the project's own `prepare`/`postinstall`
scripts, and only the manifest and the lockfile are in `/deps` when it
does — a lifecycle script needing another file needs a `COPY` of its
own. This repository's `Dockerfile.inspector` copies one extra script
(`scripts/write-build-info.mjs`) for exactly that reason, which is the
evidence the comment is worth writing.

On the **proposal** route nothing writes `check.sh`, so the link half
cannot be written either — `proposeDependencies`'s note line is
followed by a `check.sh:` line spelling out the `ln -s` that whatever
the Client commits has to do, unless `fetchingCheckWarning` already
said it (one instruction, in one place, never twice).

A `cimg/*` image does **not** run as root (its user is `circleci`), so
`/deps` is handed to that user before anything installs into it — again
copied from this repository's own file, which is the evidence for it.
`knownNonRootUser` knows that one family and nothing else: any other
image gets the plain root-default form plus a comment naming exactly
which three lines to add if it runs as someone else. Guessing a user name
would turn a legible instruction into a confusing build failure.

**A committed `Dockerfile.inspector` is never overwritten** (Client
ruling, issue #303's clarification 2). A repository that already carries
one keeps it, byte for byte; the summary, the commit message and the
pull request body all say so, and say that the proving run used
`--image` while the box Inspector builds is the one that file describes.
`check.sh` is still written with its link preamble in that case — the
shape is a fact about the repository's lockfiles, not about the
Dockerfile — so the pull request body also names the one thing only the
reviewer can settle: whether their own file puts the dependencies where
`check.sh` looks for them.

## The Ruby shape: a suite with servers in the box (issue #324)

A Rails application needs more than its gems installed. Its suite talks
to PostgreSQL and to Redis, and the check box has **no network** — so
there is no server to reach over one, and both have to run inside that
same container. Which is why this shape is the only one that reads a
lockfile's *contents*: nothing but `Gemfile.lock` can say whether this
project needs them.

Everything is derived from the repository's own signals, and each half
lands where it can actually work:

- **`Dockerfile.inspector`** — `FROM ruby:<version>` for the version
  `.ruby-version` pins, or the `Gemfile`'s own `ruby` line, or (last)
  `Gemfile.lock`'s `RUBY VERSION`, whose `3.3.4p94` patch level belongs
  to a build of Ruby rather than to an image tag. The official Ruby
  image's tags *are* exactly those versions, which is what makes this
  derivable where `go.mod`'s toolchain version is not; a version that is
  a **range**, or an implementation there is no image for (`jruby-`),
  gets the usual `REPLACE-ME-with-...`. Then the servers' Debian
  packages (`postgresql libpq-dev` when the lockfile has `pg`,
  `redis-server` when it has `redis` or `redis-client`), then
  `bundle install` into `/deps` at build time — the gems land in the
  image's own `GEM_HOME`, outside the checkout, so there is **nothing
  for `check.sh` to link in**, unlike `node_modules`.
- **`check.sh`** — creates and starts each server, **waits until it
  answers** (`pg_isready`, `redis-cli ping`) rather than sleeping a
  fixed time, creates the test database (`bin/rails db:test:prepare`,
  only when `bin/rails` is actually there), runs the suite, and stops
  both again through an `EXIT` trap so a **failing** suite stops them
  too. The trap runs no `exit` of its own, which is what keeps the
  suite's status the check's status. `scaffold.test.ts` runs that
  generated script for real against stubbed servers — the order, the
  waiting loop, the trap and the exit status are executed, not asserted
  by substring.
- **`.inspector.json`** — the usual, plus the longer timeout above.
- **The suite is named *inside* `check.sh`**, not in the config, which
  names `./check.sh`. `bundle exec rspec` as `.inspector.json`'s `check`
  would be a command running with no database anywhere near it. That is
  what `CheckField.scriptCommand` carries, and it is why the printed
  proposal is three files for this shape: the config names a script, so
  the script is part of the proposal rather than left to be worked out.
  `bundle exec rspec` wins when the lockfile has rspec; `bin/rails test`
  is the fallback for an application that ships `bin/rails`.

`libpq-dev` is there because the `pg` gem's native extension wants
`libpq-fe.h`, which is the package that installs it.

### Whoever the check box turns out to run as (issue #337)

Nothing about either server is settled at build time, and that is the
whole of this. Inspector runs the check as `docker run --user
<uid>:<gid>` for the uid of whoever invoked it — **not** the user the
image was built as, and a uid with no `/etc/passwd` entry at all. Root
happens only under a rootless Docker daemon, where Inspector resolves
`0:0` because that daemon's own user namespace has already remapped it.

So `Dockerfile.inspector` installs the packages and stops. `check.sh`
creates the cluster itself, at check time, into a scratch directory of
its own:

- **The data directory is made by whoever is running.** PostgreSQL
  refuses one it does not own, and the check-time uid is unknowable
  while the image is being built. There is no handing it over afterwards
  either: `chown` needs root, and the directory must be mode 0700.
- **`initdb --auth=trust`, never `peer`.** `peer` asks the kernel which
  uid opened the socket and then wants a role of **that user's name** —
  and a uid with no passwd entry has no name, on either side of the
  socket. `PGUSER` is exported for the same reason: libpq's own default
  user name also comes from `getpwuid`. Nothing outside the container
  can reach that socket; the box has no network, and the cluster listens
  on no TCP port at all (`-h ''`).
- **The server binaries are found, not pinned.** Debian keeps
  `initdb`, `postgres` and `pg_ctl` out of `/usr/bin` — only the client
  tools get `pg_wrapper` symlinks there — so the script resolves
  `/usr/lib/postgresql/*/bin` once and calls everything through it,
  `pg_isready` included (the `/usr/bin` one is `pg_wrapper`, which wants
  a Debian cluster configuration this one is not). A box with none fails
  the check right there, naming the missing package.
- **Root is still handled**, in one shell function: `initdb` and
  `postgres` both refuse to run as root, so `pg_as` hands the scratch
  directory to the `postgres` system user and `su`s to it. Redis needs
  neither branch.

`scaffold.test.ts` executes both branches for real, with `id` stubbed to
answer 0 for the root one.

### A failing check has to keep its own explanation

The scratch directory is the only writable place the check has, so every
server's log is inside it — and the `EXIT` trap removes it on the failing
path too. That made a red check unexplainable: "PostgreSQL did not answer
within 60 seconds" and nothing about why, because `initdb.log` and
`server.log` were deleted a second after they were written.

So `fabrica_cleanup` reads `$?` as its first line and, **on a non-zero
exit only**, prints every log under the scratch directory to stderr
before removing it. Inspector's own report is the Client's whole view of
a failed check, so a diagnosis that is not in the check's output is not
anywhere. A green check prints none of it — a passing check's output is
read by people, and startup chatter there is noise.

Three details in that trap are load-bearing rather than incidental:
`fabrica_status=$?` has to come first, because the stop lines below it
overwrite `$?`; the `[ -f … ] || continue` is what keeps a glob that
matches nothing from failing the cleanup under `set -e`; and the `cat`
carries its own `|| true`. The rule generalizes to any other throwaway
directory a generated script is given — whatever diagnoses a failure has
to leave the directory before the directory does.

### Rails writes into log/ and tmp/, which are read-only there

Inspector mounts **every top-level path the repository tracks**
read-only, and a read-only mount covers its whole subtree — so even
creating a new file in a tracked directory fails. `rails new` tracks
`log/` and `tmp/` (through a `.keep` in each). Two things write there,
and only one of them needed solving:

- **Bootsnap stops a boot dead** when its cache directory cannot be
  written. It takes `BOOTSNAP_CACHE_DIR`, which `check.sh` points into
  the scratch directory, along with `TMPDIR`.
- **Rails' own logger does not.** `initialize_logger` catches a log file
  it cannot open and falls back to stderr with a warning. So nothing is
  done about `log/`, deliberately.

### And all of it is run, not asserted

`inspector-e2e.test.ts` registers a Rails application that really boots
(`helpers/rails-app-fixture.ts`: `pg`, `redis` and `rspec`, a tracked
`log/` and `tmp/`, one spec that uses the database and one that uses
Redis) both ways, hands each to the real `inspector`, and reads
`outcome: "green"` out of Inspector's own report. It skips only when
Docker is absent; a missing `inspector` is a failure, not a skip. See
that file's header for the pin, and why the verdict comes from the
report rather than from an exit code.

### What it says it has not done

The standing rulings call a silent skip a bug, so each of these is a
`note:` line of its own:

- **Browser and system tests are out of scope** (issue #324's own
  words). A `capybara` or `selenium-webdriver` in the lockfile is named,
  and nothing installs a browser or a driver.
- **Only those two servers are recognized.** A `mysql2` or `trilogy` in
  the lockfile is named, with what to add and where.
- **A `package-lock.json` beside the `Gemfile.lock` is not installed**,
  and the note says so plus what to add if the check needs built assets.
- **Those servers are installed by `Dockerfile.inspector`, which the one
  proving run never builds.** It runs the check inside the image
  `--image` names — the `FROM` line — so the server binaries genuinely
  are not there, and the check fails on saying so. This is the one check
  shape the `--check`/`--image` route cannot prove here, and both the
  proposal's notes and the `check-failed` refusal say so rather than
  leaving a missing-binary error to be puzzled over. (Before issue #337
  the reason was root: starting the servers needed it, and
  `src/containment/run.ts` runs every container as the *host* user. That
  is no longer the obstacle — the cluster is created at check time by
  whoever is running — but the conclusion is unchanged.) The `--terms`
  route and the commit-it-yourself route are unaffected, and a first
  task's own red-or-green is the proof.

Nothing about PostgreSQL, Redis or Rails themselves is proven by this
repository's tests: that needs the built image, which is Inspector's to
build. What is proven is the generated script and the generated
Dockerfile — that the script runs, in the right order, with the right
exit status, and that the Dockerfile leaves no server running (a `RUN`
is its own container, so a service started in one is gone by the next
line; `check.sh` is the only thing that starts one).

## `--timeout`, and the one proving run

`--timeout <seconds>` writes `timeoutSeconds`, and describes the box
**Inspector** will run the check in later. "Off" is the **absence** of
the key, not `timeoutSeconds: 0`: that spelling appears in no live
config in reach, and the rule above — only write keys and values some
working config actually shows — applies to values as much as to names.

It changes nothing about the one proving run `register` itself does, and
has nothing to bind to on this side at all — `RunContainedOptions` has
no timeout.

That proving run is `./check.sh` inside `--image`, with
`network: "allowed"` (`tools.ts`'s `realRunCheck`), which is the one
place this command's box deliberately differs from Inspector's: a check
about to be green must not read as **red** here, and a check whose
dependencies the Dockerfile bakes has no `/deps` in the raw `FROM`
image, so its `check.sh` falls through to installing them for real. It
also still pulls the tag, which is what proves the `FROM` line resolves
before anything is pushed.

The honest cost, stated rather than hidden: a check that cannot run in a
networkless box still passes here and fails later, under Inspector. The
alternative trade — denying that run a network Inspector's build step
does have — is worse, since it blocks setup outright instead of
producing a red first task with a legible reason. The shape that trap
most often takes is a check command that installs its own dependencies,
so `registerWarnings` names that one on the result and in the pull
request body, before the merge.

## One source of truth for the check

`projects.toml`'s `check` is always `./check.sh` — not the `--check`
command verbatim — in the full, the shortcut and the work-mode case
alike. `check.sh`
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
shellcheck`) cannot pass `register`'s proving run, and `register` will
refuse with the check's own output. The answer is to put that package in
`Dockerfile.inspector` — a build step runs as the image's own user, with
a network, which is exactly why the install moved there — or to name an
`--image` that already ships it. What must not happen is the check
installing it while it runs: that fails in the proving run here and in
Inspector's networkless box alike.
