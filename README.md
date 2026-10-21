<img width="1280" height="720" alt="fabrica" src="https://github.com/user-attachments/assets/9d506471-80ae-4791-b019-bb46180ec450" />

# Fábrica - Phase 1, in progress

![The loop](loop.svg)

The answer key was committed first. The tool is now being built against it.

- `CONTRACT.md` - the rules the tool can never break, in plain language.
- `contract/` - the same rules as runnable tests. This is the enforcement.
- `SPEC.md` - the blueprint for version one.
- `ROADMAP.md` - the path from here to Amy.
- `src/` - the tool itself, as far as it has been built.
- `skill/` - session setup for the AI you talk to, per harness. Templates
  you review and install by hand; nothing here installs itself.

To see the current state:

    npm install
    npm test

Expected today: **every contract test green**. `npm test` runs the
contract suite together with the tool's own tests; a red contract test
is a real regression, not an unbuilt part. Run the command yourself for
the exact tally, since the tool's own test count still moves with every
issue closed. This project is itself registered with Inspector, so every
task Fabrica runs against it hands that same suite to Inspector, which
runs it in its own container before any work is delivered.

Phase 1 has exactly one definition of done: every contract test turns green.

## Developing Fabrica itself

If you're changing Fabrica's own code rather than just using it, link
this checkout instead of installing a frozen copy:

    npm install
    npm link

`npm link` puts `fabrica` on your `PATH`, pointed at *this checkout's*
source files - there is no build step, it runs `src/`'s TypeScript
directly, so every edit, and every mid-merge conflict marker, is live
immediately. That's exactly backwards for anyone who isn't actively
editing this repo, which is why the global install below exists
instead: a frozen copy that can't break just because some checkout
somewhere is mid-edit. `npm unlink -g fabrica` undoes it.

## Installing the command

Prerequisites: **Node 24.18.0**, **git**, and **Docker** (Docker is only
needed to actually run a task - not for this install step itself). That
Node version is exact, not a floor: it is what `.node-version` holds, so
`fnm install`/`nvm install` in a checkout picks it up on their own, and
`package.json` declares it strictly enough that npm refuses to install
on a different one. It is the same version the check box and the Worker
container run, which is the point - `fabrica doctor` reports a mismatch
as a FAIL.

    npm install -g github:inactdev/fabrica

If you have ever run `npm link` from a checkout of this repository, run
`npm unlink -g fabrica` first - that leftover symlink makes this install
fail with `ENOTDIR`, and `fabrica doctor` reports it with the same fix.

That's the whole install. It puts a fixed, standalone copy of `fabrica`
on your `PATH`, working from any directory - verified against a real
install: npm clones the repo, runs its own build step (recording the
exact commit it was built from, see `fabrica doctor` below), and copies
the result into place. Nothing under this command's control touches
your shell profile or any other file on the machine.

That installed copy is frozen: it does not change when some other
checkout of this repository changes, including one you are actively
editing, mid-merge, or on a branch - the problem that motivated this
install method. To upgrade later, run `fabrica update` (or the same
install command again); `fabrica update` reinstalls into the prefix this
copy actually lives under, which matters on a host whose default npm
prefix is read-only. There is no uninstall step beyond the ordinary `npm
uninstall -g fabrica`.

**`npm link` is a separate, developer-only install**, documented above
under "Developing Fabrica itself" - it points the `fabrica` command at
a checkout's live source files, so every command breaks the moment that
checkout is mid-edit or mid-merge. Reach for the global install above
unless you are changing Fabrica's own code.

### Building the worker image

Running a task needs Docker: every Worker call runs inside a throwaway
container, built once from `src/brain/adapters/docker/Dockerfile`. Run

    fabrica doctor

and, if the image is missing or out of date, it prints the exact
`docker build` command to run (the command embeds a hash of the
Dockerfile itself, which changes over time - `doctor` is the one place
that command is kept current, rather than copied here where it would go
stale). See `src/containment/README.md` for what the container confines,
and `src/brain/adapters/claude-code.md` for how the coding agent's
credential reaches it - set up in the next section.

### The worker token

The coding agent that does the work needs its own credential, kept out
of your shell environment by default:

    claude setup-token

then put the printed token in `~/.fabrica/brain.env` as a single line:

    CLAUDE_CODE_OAUTH_TOKEN=<token>

and lock it down:

    chmod 600 ~/.fabrica/brain.env

`fabrica doctor` (below) checks for exactly this file and mode, and
never prints the token itself.

The token never reaches the Worker: its container sits on an isolated
Docker network with no route out, and every call it makes goes through
a relay Fabrica runs beside it, which swaps the throwaway placeholder
the Worker holds for the real token on its way to the provider (see
`src/relay/README.md`).

### Paying per token instead (optional)

The default Worker is the coding agent above, on the flat-rate
subscription you already have. If you want a different model - an
open-weight one, a hosted one you pay per token for, or one running on
your own machine - there is a second Worker that talks to any
OpenAI-compatible API directly. It **will not start without a per-task
spending cap** (`[caps].perTaskUsd`), and every dollar on its receipts
is the real figure the provider charged for the call.

Add to `~/.fabrica/brain.env` (same file, same `chmod 600`):

    FABRICA_BRAIN=openai-compatible
    FABRICA_MODEL=<the model id, exactly as your provider names it>
    OPENROUTER_API_KEY=<your key>

Leave `FABRICA_BRAIN` out and nothing changes. `fabrica doctor` then
reports which model at which endpoint, and `fabrica doctor --live`
spends a fraction of a cent to confirm it answers and reports its own
cost. To point it somewhere else entirely - a local server, say - set
`FABRICA_MODEL_BASE_URL`. See
`src/brain/adapters/openai-compatible.md` for every setting, what was
verified against which vendor document, and what still needs checking
on your own machine.

### `fabrica doctor`

    fabrica doctor

Run this after installing, and any time something seems wrong. It is a
preflight that spends nothing: one line per check - `OK`, or `FAIL` with
the exact fix - covering Node, which copy of `fabrica` you're actually
running (a developer checkout's branch and commit, or an installed
copy's version and commit, either way compared against the project's
`origin/master`), Docker, the worker image, the coding agent's version
installed inside it, the relay image every task's network goes through,
the worker token above, the GitHub token Inspector needs, Inspector
itself, every project you've registered, your spending caps, and any
unmeasured spend blocking new work. `fabrica doctor --live`
additionally spends a few cents to confirm the worker token actually
authenticates.

The **inspector** line also reports which build of Inspector you have:
the commit the installed binary was built from, against the tip of
Inspector's own `main`. A binary behind `main` is a `FAIL`, and the fix
is the exact command that replaces it, pinned to that commit - run it
and the line goes green. A binary you built yourself from a checkout
passes with its commit named, since it may be ahead of `main`; so does
one whose commit can't be read, or a run that can't reach GitHub at all
(no network is not a stale binary).

Two of those lines are about the network a Worker gets. **relay image**
fails if the image the relay container runs from isn't on the machine -
no task can start its relay without it - and prints the exact `docker
pull`. **worker CLI** reports the coding agent's version as actually
installed in the worker image against the version the Dockerfile pins,
and only fails when those two disagree.

### Installing Inspector (optional)

Inspector independently checks and can publish a Worker's green work
(see "If the task's base commit contains `.inspector.json`" below). It
is a separate Go tool, not an npm package:

    go install github.com/inactdev/inspector/cmd/inspector@latest

This needs **Go 1.22+**, and puts `inspector` wherever `go install`
puts binaries on your machine (make sure that's on `PATH`). Without it
installed, a project that carries an `.inspector.json` is self-tested
in the Worker's own box instead - but `fabrica register` writes that
file into every project it sets up, and `fabrica do` refuses a project
whose base commit has none, so in practice this step is worth doing.
Keep it current the same way: `fabrica doctor`'s **inspector** line
fails once the installed binary is behind Inspector's `main` and prints
the `go install` that catches it up. Reading the installed binary's own
commit uses `go version -m`, so leaving Go on `PATH` after the install
is what lets that line say anything; without it the line reports that
and passes.
See `src/inspector/README.md` for the publishing boundary.

## Registering a project

Once per project, before its first task:

    fabrica register <path> --check "<command>" --image <docker image>

`<path>` is the repository's own root, and it needs an `origin`. The
command is the one thing that must pass for work on that project to be
green; the image is what it runs inside, here and for every later task
(Fabrica never runs a project's check on your machine).

It writes a `check.sh` holding that command and an `.inspector.json`
naming it, runs the check once inside the image, and - only if it
passes - commits, pushes a `fabrica/register` branch with your own git
credentials, and opens a pull request with `gh pr create` for **you**
to merge. Then it appends the project to `~/.fabrica/projects.toml`:

    [projects.spending-app]
    path = "/Users/you/inkling-umbrella/spending-app"
    check = "./check.sh"

Everything that can refuse refuses before anything is created: a path
that isn't a repository, a missing `origin`, a `gh` that isn't logged
in, a stopped Docker daemon, a `fabrica/register` branch that already
exists, or a project already registered. A failing check refuses too,
with its output - nothing is pushed. It needs `gh` (logged in) and
Docker; `--protected <glob,...>` adds paths a Worker may never quietly
change, on top of `check.sh` and `.inspector.json`, which always are.

Two more flags describe the box the check runs in later, and go into
`.inspector.json`: `--network`, if the check installs its own project
dependencies (`npm ci`, a virtualenv) and so cannot pass without a
network, and `--timeout <seconds>`, if it needs longer than Inspector's
own default. Both are off unless you pass them. A check that installs a
*system* package needs an `--image` that already ships it rather than a
flag - every check box runs as your own user, and so can write only
inside the project.

This is the one Fabrica command that pushes, and it is allowed to
because of what it is: it runs as you, on your machine, with your own
credentials, and the only thing it ever puts on origin is a branch you
still have to merge. It never merges, never force-pushes, never touches
an existing branch, and never runs inside a Worker.

If the repository already has `.inspector.json` on origin's default
branch, it is set up already - only the `projects.toml` entry is added,
and `--check`/`--image` aren't needed.

## Running a task

    fabrica do "<task text>" --project <path-or-name>

Prints the new task's id and returns immediately; the work continues in
the background (`src/cli/README.md` has the full design). `--project`
takes either a plain filesystem path, or the name of a project already
registered in `~/.fabrica/projects.toml` (see "Registering a project"
above).

A project whose base commit - origin's default branch, which is where
every task's branch is cut from - carries no `.inspector.json` is
refused right here, before the task is registered at all:

    this project isn't set up for Fabrica yet: run fabrica register
    <path> --check ... --image ...

There is nothing in that commit saying how the work should be checked,
so there is no verified work to be had; refusing before anything starts
is what makes that cost nothing.

If the task is ambiguous enough that the answer would change what gets
built, nothing is started: you get numbered questions instead, and one
round to answer them.

    fabrica answer <id> -m "<text>"

That folds your answer into the brief and runs the task, this time in
the foreground.

If the task's base commit contains `.inspector.json`, a green Fabrica
check triggers Inspector before delivery. Fabrica never pushes the
branch itself: Inspector may publish green work, returns red work with a
report for your verdict, and records a refusal without creating a
Client delivery. See `src/inspector/README.md` for the publishing
boundary and the current compatibility limitation.

While it runs, you can see where it stands without opening a record file
yourself:

    fabrica status         # every open task: id, project, state, age
    fabrica log <id>       # one task's event history (--transcript for the raw output)
    fabrica watch <id>     # follow that task while it runs

`status` flags a delivered task as waiting on your verdict, shows a task
that is running its check with how long it has been at it, and calls a
working task that has recorded nothing for a while quiet - silence never
gets to look like progress. A task that failed before any work started
stays on the list, marked "FAILED, UNRESOLVABLE" and sorted below the
tasks still moving, so it neither disappears nor looks live. An Inspector
refusal means no verdict was reached: it is shown separately, never as
working or failed, and points to `fabrica log <id>` for the reason.
`watch` follows one task the same way: heartbeats appear live, and the
worker's own transcript arrives in a batch at the end of each attempt.
Stopping `watch` (Ctrl-C) stops only the watching; the work runs on in
its own process.

When the work comes back, you get the last word:

    fabrica verdict <id> <accept|fix|wrong> [-m "<note>"]

`accept` and `wrong` close the task. `fix` keeps it open and hands your
note back to the same worker on the same branch - unlimited, but
counted, so each round reports which one it is (`src/foreman/README.md`
has the exact rules).

Set `FABRICA_HOME` to use a record home other than `~/.fabrica`. Run
`fabrica --help` or `fabrica <command> --help` for the rest.

## Money limits

`~/.fabrica/projects.toml` can carry a `[caps]` table:

    [caps]
    perTaskUsd = 5
    perDayUsd  = 25

`perTaskUsd` caps what a single task may spend in total, counting every
attempt, resume, and fix round on it. `perDayUsd` caps spend across all
tasks. Either field may be omitted; an omitted field has no cap. With
no `[caps]` table at all, nothing is capped.

The daily cap is a **rolling 24 hours**, not a calendar day: spend ages
out exactly 24 hours after the attempt that incurred it started, not at
midnight, so there is no single moment a full day's budget returns at
once.

If any attempt's real cost could not be read, it is never treated as
free - `fabrica status` opens with `SPEND UNKNOWN - tasks blocked`, and
while a cap is set, that block refuses every new task, resume, and fix
round, however old the unmeasured attempt is. Only the owner can clear
it, by looking up the real figure and recording it by hand with
`fabrica cost <taskId> <usd>`; it is the one way out, and it is denied
to the AI you talk to for the same reason `fabrica verdict` and
`fabrica answer` are.

## Subscription limits

Money caps cannot see a flat-rate subscription: filling a week's quota
costs nothing, so a task can run the whole week down without a cent of
metered spend appearing anywhere. So the two meters the model provider
reports - how much of its **5-hour** and **7-day** windows the account
has used - are recorded on every receipt and shown by `fabrica status`
and the phone review page:

    subscription meters: 5h 7%, 7d 64% (new work stops above 70% of the week, running work above 90%)

and a plain pause rule, in its own `projects.toml` table, decides what
to do about them:

    [pause]
    sevenDayRefusePercent = 70   # above this, no new work starts
    sevenDayStopPercent   = 90   # above this, work already running is stopped
    fiveHourRefusePercent = 90   # above this, no new work starts

Those are the defaults; with no `[pause]` table at all, they still
apply. The 7-day window is the one that stops work already in flight -
the 5-hour one refills within hours, so stopping a running attempt for
it would throw away more than it saves. A task stopped this way is
**not** a failure: it is delivered as `paused-by-meter`, says so on
`fabrica status`, and waits for you - nothing restarts by itself. Give
it a `fabrica verdict <id> fix` once the window has rolled forward, or
raise the threshold to continue now.

If the meters cannot be read - no reading yet, or the last one is over
an hour old - nothing is refused and `fabrica status` says exactly
that. A number nobody could read never stops work.

The dollar caps above are unchanged by any of this, and still bind on
real, metered spend only.

## What a task may reach on the network

A Worker's container has no route to the internet at all. Everything it
sends goes through a relay Fabrica runs beside it, and the relay turns
away anything the project didn't ask for. Out of the box that means the
model provider and GitHub - nothing else.

A project that needs more says so in its own entry in
`~/.fabrica/projects.toml`:

    [projects.spending-app]
    path = "/Users/you/inkling-umbrella/spending-app"
    check = "./check.sh"
    hosts = ["registry.npmjs.org"]

`hosts` is **added to** the model provider and GitHub, never a
replacement for them, so listing a registry can't accidentally cut a
task off from the things every task needs. An entry is a host name,
optionally with one port (`"example.com:8443"`), optionally with a
leading `*.` to cover one level of subdomain (`"*.example.com"` covers
`api.example.com`, not `example.com` itself - list both if you need
both). A host the project never listed is refused, and the refusal is
on that task's own record with the host named: `fabrica log <id>`.

This is what a check that installs its own dependencies needs. With
`registry.npmjs.org` listed, `npm ci` inside the Worker's box works;
without it, it is refused.

Two limits apply to the same traffic, both overridable in the same
place:

    maxRequestBytes = 10485760   # default: 10 MB, per request
    maxCallsPerTask = 2000       # default: 2000 calls, per task

Going over either refuses that one request - and nothing more. The task
keeps running: your spending cap is the only thing that stops a task.

## Stopping the AI you talk to from editing files or ruling for you

Install the session config for your harness by hand to stop the AI you
talk to from editing files at all, and from running `fabrica verdict` or
`fabrica answer` - the two commands that record your own judgment.
`skill/claude-code/README.md` has the steps, what is verified, and the
limits of the verdict/answer half. Then, from the directory you installed
it into:

    fabrica verify-hook

It asks your chat agent, right now and with no permission bypass, to
create a throwaway file there, and reports whether the edit was denied
and whether the attempt was recorded - so "is this working" is something
you prove rather than assume.
