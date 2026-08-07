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

Expected today: **mostly green, a little red, on purpose**. `npm test`
runs the contract suite together with the tool's own tests. The loop
itself (`fabrica do`) is built and most contract rules pass; the tests
still red reach for the parts that do not exist yet. Run the command for
today's exact tally - it is meant to move with every issue closed, so it
is not quoted here.

Phase 1 has exactly one definition of done: every contract test turns green.

## Installing the command

    npm install
    npm link

`npm link` puts `fabrica` on your `PATH`, working from any directory.
There is no separate build step - it runs `src/`'s TypeScript directly.

Running a task also needs Docker: every Worker call runs inside a
throwaway container, built once from
`src/brain/adapters/docker/Dockerfile` (that file carries the exact
build command). See `src/containment/README.md` for what the container
confines, and `src/brain/adapters/claude-code.md` for the one step still
open inside it - the coding agent's credential.

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

While it runs, you can see where it stands without opening a record file
yourself:

    fabrica status         # every open task: id, project, state, age
    fabrica log <id>       # one task's event history (--transcript for the raw output)
    fabrica watch <id>     # follow that task while it runs

`status` flags a delivered task as waiting on your verdict, shows a task
that is running its check with how long it has been at it, and calls a
working task that has recorded nothing for a while quiet - silence never
gets to look like progress. `watch` follows one task the same way:
heartbeats appear live, and the worker's own transcript arrives in a
batch at the end of each attempt. Stopping `watch` (Ctrl-C) stops only
the watching; the work runs on in its own process.

When the work comes back, you get the last word:

    fabrica verdict <id> <accept|fix|wrong> [-m "<note>"]

`accept` and `wrong` close the task. `fix` keeps it open and hands your
note back to the same worker on the same branch - unlimited, but
counted, so each round reports which one it is (`src/foreman/README.md`
has the exact rules).

Set `FABRICA_HOME` to use a record home other than `~/.fabrica`. Run
`fabrica --help` or `fabrica <command> --help` for the rest.

## Changes no task explains

Every `fabrica` command first checks each registered project for changes
that no task accounts for - your own edits, or an agent editing the
checkout directly - and writes an `unattributed-change` event to the
record. It only records: a false positive never blocks a command. See
`src/offbooks/README.md` for exactly what fires and what stays quiet.

To stop the AI you talk to from editing files at all, install the
session config for your harness by hand -
`skill/claude-code/README.md` has the steps and what is verified.
