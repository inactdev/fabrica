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

Prerequisites: **Node 24**, **git**, and **Docker** (Docker is only
needed to actually run a task - not for this install step itself).

    npm install -g github:inactdev/fabrica

That's the whole install. It puts a fixed, standalone copy of `fabrica`
on your `PATH`, working from any directory - verified against a real
install: npm clones the repo, runs its own build step (recording the
exact commit it was built from, see `fabrica doctor` below), and copies
the result into place. Nothing under this command's control touches
your shell profile or any other file on the machine.

That installed copy is frozen: it does not change when some other
checkout of this repository changes, including one you are actively
editing, mid-merge, or on a branch - the problem that motivated this
install method. To upgrade later, run the same command again. There is
no uninstall step beyond the ordinary `npm uninstall -g fabrica`.

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

### `fabrica doctor`

    fabrica doctor

Run this after installing, and any time something seems wrong. It is a
preflight that spends nothing: one line per check - `OK`, or `FAIL` with
the exact fix - covering Node, which copy of `fabrica` you're actually
running (a developer checkout's branch and commit, or an installed
copy's version and commit, either way compared against the project's
`origin/master`), Docker, the worker image, the worker token above, the
GitHub token Inspector needs, Inspector itself, every project you've
registered, your spending caps, and any unmeasured spend blocking new
work. `fabrica doctor --live` additionally spends a few cents to confirm
the worker token actually authenticates.

### Installing Inspector (optional)

Inspector independently checks and can publish a Worker's green work
(see "If the task's base commit contains `.inspector.json`" below). It
is a separate Go tool, not an npm package:

    go install github.com/inactdev/inspector/cmd/inspector@latest

This needs **Go 1.22+**, and puts `inspector` wherever `go install`
puts binaries on your machine (make sure that's on `PATH`). Skip this
step entirely if none of your registered projects carry an
`.inspector.json` - Fabrica self-tests those in the Worker's own box
instead. See `src/inspector/README.md` for the publishing boundary.

## Running a task

    fabrica do "<task text>" --project <path-or-name>

Prints the new task's id and returns immediately; the work continues in
the background (`src/cli/README.md` has the full design). `--project`
takes either a plain filesystem path, or the name of a project already
registered in `~/.fabrica/projects.toml`:

    [projects.spending-app]
    path  = "~/inkling-umbrella/spending-app"
    check = "bin/ci"

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
