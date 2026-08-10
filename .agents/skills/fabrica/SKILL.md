---
name: fabrica
description: Operate the fabrica CLI on the Client's behalf - run tasks, read task state, and record verdicts. Use whenever the Client asks you to have Fabrica do something, asks about a Fabrica task's status, or asks you to accept/fix/reject a Fabrica delivery. Never edit project code yourself when Fabrica is the tool for the job.
user-invocable: false
---

# Operating Fabrica

Fabrica is a terminal tool that takes a task, does the work on a disposable
copy of the project, verifies it against the project's own checks, and
delivers honestly. You do not type `fabrica` commands as a convenience on
top of doing the work yourself - **you are the only way the Client's words
reach the tool.** Read this whole file before running anything.

## The three taboos

These are load-bearing. Breaking any one of them defeats the reason Fabrica
exists, in a way no other correctness matters as much.

**1. Never do the work yourself.**
You run `fabrica do`; you do not open the file and fix the bug, even if you
can see exactly what's wrong, even if `fabrica` seems slow. An agent that
edits the Client's project directly is an unsupervised worker: no isolated
line, no check run, no delivery record, no verdict gate. The whole point of
Fabrica is that every change to the Client's code passes through that
machinery. Reach for a text editor here and you've silently opted the
Client out of it.

**2. Never announce state you did not just query.**
Don't say "it's running" because it was running ten minutes ago - look
again. This is the most common real failure mode: reporting a remembered
state as a current one. Fabrica's tasks run detached and can take a long
time; between your last check and now, a task can finish, fail, or still be
exactly where you left it. Every claim about a task's status must be backed
by a command or file read you just did in this turn, not a memory of an
earlier one. `fabrica status`/`log`/`watch` exist precisely so this is
never an excuse to guess - use them instead of estimating from elapsed time.

**3. Pass the Client's words through verbatim.**
Task text (`fabrica do "<...>"`), a clarifying answer (`fabrica answer <id>
-m "<...>"`), and a verdict note (`fabrica verdict <id> ... -m "<...>"`) are
all the Client's own words reaching the tool through you - never summarized,
rephrased, or "improved" en route. The same goes for the ruling itself:
`accept`, `fix`, or `wrong` are the only three words, chosen exactly, never
a synonym like "approve" or "reject" that happens to mean the same thing to
you but isn't what the command takes.

## The commands

Fabrica ships six commands today: `do`, `answer`, `verdict`, `status`,
`log`, `watch`. Run `fabrica --help` or `fabrica <command> --help` to check
this hasn't changed before relying on anything below - a handbook can go
stale, a `--help` flag can't.

### `fabrica do "<task text>" --project <path-or-name>`

Hands a task to Fabrica. Quote the task text. `--project` is either a path
to the project's own git checkout, or a name already registered in
`projects.toml` (see "The record" below).

Every task gets one clarifying pass before any work starts. Two outcomes:

- **Materially ambiguous** - prints numbered questions to stderr and stops,
  exit 0. Nothing has touched the project yet. Resume with
  `fabrica answer <taskId> -m "<text>"`.
- **Clear enough to proceed** - returns almost immediately, printing one
  line to stdout: the task's id (e.g. `20260810-fix-login-bug-q7`). The
  work itself keeps running in the background after this command exits -
  it is not done when the command returns, only *registered and started*.

A third outcome exists and matters just as much: the clarifying pass itself
can fail outright (a brain-adapter problem, nothing to do with the task),
in which case the real reason prints to stderr and the command exits
non-zero. The task id still printed to stdout is real - the task was
registered - but nothing further will happen to it; `fabrica log <id>` has
the full reason.

Stdout is always exactly the task id, one line, in every one of these three
cases - that's what makes `id=$(fabrica do "..." --project foo) || exit 1`
a safe script. Don't tell the Client the task is finished because the
command finished; the command finishing only ever means the task now
exists and one of the three things above happened to its first pass.

A malformed call (missing task text, missing `--project`, an unknown flag)
refuses immediately with an exact usage message and does not start
anything - read that message back to the Client rather than guessing at
the right shape yourself.

### `fabrica answer <taskId> -m "<text>"`

Answers the clarifying questions a `fabrica do` printed and stopped on, and
resumes the task - the brief is extended with the Client's answer, and the
task then runs exactly as it would have if it had never needed to ask.
Unlike `do`, this runs synchronously: it doesn't return until that round
finishes, and reports the outcome directly.

One clarification round per task - once it has actually delivered, a
second `fabrica answer` on the same task is refused. A round that failed
before delivering isn't spent: calling this again retries it.

### `fabrica verdict <taskId> <accept|fix|wrong> [-m "<note>"]`

Records the Client's ruling on a task that has already delivered (check
first with `fabrica status` or `fabrica log`). This is the only way a task
closes - Fabrica does not decide on the Client's behalf, and it keeps a
delivered task open until this is called.

- `accept` - the work is right. Closes the task.
- `fix` - right direction, wrong details. `-m "<note>"` is *required* here:
  it becomes the correction handed back to the same worker, on the same
  disposable line. Runs synchronously and can take a while - the command
  reports that round's outcome when it returns. There is no limit on how
  many `fix` rounds a task can have; each one is counted and reported
  ("fix round 3 recorded"). The task stays open after a `fix` - it still
  owes a final `accept` or `wrong` once the Client has reviewed the new
  result.
- `wrong` - not what was wanted, not worth correcting. Closes the task.
  This is a legitimate outcome, not a system failure - don't apologize for
  Fabrica or the worker on the Client's behalf.

`-m` is optional for `accept` and `wrong`, required for `fix`. Only relay a
verdict once you've confirmed, this turn, that the ruling is what the
Client actually said (taboo 3) and that the task is actually delivered
(taboo 2, and `verdict` refuses cleanly with the real reason if it isn't).

### `fabrica status`

One line per **open** task: id, project, state, age. The one thing this
view exists to make impossible to miss: a `delivered` task is flagged
`<- AWAITING YOUR VERDICT` since nothing else says a task is sitting there
waiting on the Client. A task mid-check shows its real elapsed time
(`<- checking, 2m so far`) instead of a guess. A task that's gone quiet too
long - no recorded activity in a while, working but nothing to show for
it - is flagged `<- quiet ...`, explicitly "not known to be stuck, not
known to be fine," rather than implying progress nobody has actually
observed. A closed task (verdict recorded) drops off this list; see
`fabrica log <id>` for its history. The project column reads
`unknown project` for a task that failed before work ever started - it's
read off a `work-started`/`delivered` event that a task failing that early
never gets to write, not a sign anything is broken.

### `fabrica log <taskId> [--transcript]`

Prints one task's full event history, in order, rendered readably - not the
raw stored JSON. A long run of heartbeats (Fabrica's own liveness pings,
roughly every 15s while a worker is running) collapses into one line ("14
heartbeats over 3m") so it doesn't bury the real events around it.
`--transcript` additionally prints the worker's raw activity, oldest first.
This is the command for "what actually happened to this task" - reach for
it before guessing at a task's history from its current state alone.

### `fabrica watch <taskId>`

Follows one task live: heartbeats as they happen, the worker's transcript
in batches (one per finished attempt, not word by word), the same "quiet"
and "checking, Xm so far" notices `status` uses. When the task reaches a
state nothing further will happen from without the Client acting - delivered,
failed, closed, or asking - it prints a plain notice saying so and, for
`watch`, stops polling on its own. Stopping this yourself (Ctrl-C) only
ever stops watching; it can never touch the worker, which runs in an
already-detached process this command only ever reads from, never signals.

## The record

Fabrica writes everything to plain files under its record home
(`~/.fabrica` by default, or `$FABRICA_HOME` if set - check which one is in
play before reading, since a Client may be pointing you at a non-default
home for a specific project). The commands above are how you should read
this in practice; reach for the raw files only when you need something they
deliberately don't show (`fabrica log`'s summary leaves out a delivery's
full raw check output, for instance) or need to be sure of the exact stored
shape.

```
$FABRICA_HOME/
  projects.toml             the project registry and caps - the one file
                             under here you are expected to hand-edit, to
                             register a new project (fabrica do tells you
                             the exact TOML to add when --project doesn't
                             match a path or a registered name)
  cli.log                   shared across every task ever run in this
                             record home, not one task's own file - the
                             detached process's raw stdout/stderr, useful
                             when a task never got far enough to leave a
                             proper record of its own
  events.jsonl              one JSON line per event, in order, for every
                             task - the single source of truth
  tasks/<id>/
    request.md               the Client's task text, verbatim
    answers.md                each clarification round: question asked,
                               answer given
    brief.md                  request + every answer, assembled - the
                               exact input the worker received
    plan.md                   the worker's own plan, on a round that went
                               straight to work instead of asking
    delivery.md               the delivery block, or a failure report -
                               only exists once the task has actually
                               delivered
    verdict                   every ruling recorded so far, one line each
    transcript.log             the worker's raw activity, one JSON line
                               per entry
    worktree/                  the disposable git checkout Fabrica cut for
                               this task - gone once the task is torn down,
                               so don't expect it to outlive a delivery
```

Never hand-edit anything under `tasks/` or `events.jsonl` - that's
Fabrica's own record, the same way the Client's project code is off limits
to you (taboo 1). `projects.toml` is different and is meant to be
hand-edited: it's the Client's own project registry, and `fabrica do`'s own
error message tells you exactly what to add to it when a project isn't
registered yet.

## Putting it together

A typical exchange:

1. Client describes what they want done, to some project.
2. You run `fabrica do "<exactly what they described>" --project <...>`.
   Relay the printed task id back to the Client, and say plainly which of
   the three outcomes happened - starting, asking, or failed before
   starting - never that it's "done."
3. If it asked, relay the questions, get the Client's actual answer, and
   run `fabrica answer <id> -m "<their answer, verbatim>"`.
4. When the Client checks in (or you're asked to check), run
   `fabrica status` or `fabrica log <id>` right then - don't reuse an
   earlier answer. Report whatever you actually find.
5. Once a task shows `delivered`, relay `fabrica log <id>`'s summary to the
   Client in plain language and wait for their ruling - especially don't
   drop or soften anything it flags as a declared gate change, that's
   exactly the kind of thing that must never slide through quietly. When
   they give a ruling, translate their exact words into
   `fabrica verdict <id> <accept|fix|wrong> [-m "<note>"]` and run it.
6. If it was `fix`, the command reports the new round's outcome directly;
   relay that, and remind the Client the task is still open pending their
   next verdict.

If anything about the situation doesn't fit neatly into the above - a
command errors in a way this file doesn't describe, the record looks
inconsistent, the Client asks for something Fabrica has no command for -
say so plainly and ask, rather than improvising a workaround that touches
the Client's project directly.
