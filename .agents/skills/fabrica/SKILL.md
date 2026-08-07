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
earlier one.

**3. Pass the Client's numbers through verbatim.**
If the Client says three attempts, three attempts is what goes in - never
rounded, reinterpreted, or "improved" because two seemed safer or five
seemed more thorough. The same goes for exact verdict wording (`accept`,
`fix`, or `wrong` - no synonyms) and notes passed with `-m`: pass the
Client's own words, don't summarize or rephrase them into the command.

## The commands

Fabrica ships two commands today. Run `fabrica <command> --help` to check
this hasn't changed before relying on anything below - a handbook can go
stale, a `--help` flag can't.

### `fabrica do "<task text>" --project <path-or-name>`

Hands a task to Fabrica. Quote the task text. `--project` is either a path
to the project's own git checkout, or a name already registered in
Fabrica's `projects.toml`.

This returns almost immediately, printing one line: the new task's id
(e.g. `20260807-fix-login-bug-q7`). The work itself keeps running in the
background after this command exits - it is not done when the command
returns, only *registered and started*. Do not tell the Client the task is
finished because the command finished; the command finishing only means
the task now exists and is underway.

Example:
```
$ fabrica do "Add a greetLoudly(name) function that returns the greeting in uppercase" --project ~/code/spending-app
20260807-add-a-greetloudly-name--6v
```

A malformed call (missing task text, missing `--project`, an unknown flag)
refuses immediately with an exact usage message and does not start
anything - read that message back to the Client rather than guessing at
the right shape yourself.

### `fabrica verdict <taskId> <accept|fix|wrong> [-m "<note>"]`

Records the Client's ruling on a task that has already delivered (see
"Reading task state" below for how to confirm it has). This is the only
way a task closes - Fabrica does not decide on the Client's behalf, and it
keeps a delivered task open until this is called.

- `accept` - the work is right. Closes the task.
- `fix` - right direction, wrong details. `-m "<note>"` is *required* here:
  it becomes the correction handed back to the same worker, on the same
  disposable line, counted against the task's original attempt budget.
  This runs synchronously and can take a while - the command itself
  reports that round's new outcome when it returns. The task stays open
  after a `fix`; you still owe it a final `accept` or `wrong` once the
  Client has reviewed the new result.
- `wrong` - not what was wanted, not worth correcting. Closes the task.
  This is a legitimate outcome, not a system failure - don't apologize for
  Fabrica or the worker on the Client's behalf.

`-m` is optional for `accept` and `wrong`, required for `fix`. There is
exactly one way to pass a note - `-m "<text>"` - the same shape as
`git commit -m`. A bare trailing note with no flag is refused, not
silently accepted.

Only relay a verdict once you've confirmed, this turn, that the ruling
is what the Client actually said (taboo 3) and that the task is actually
in a delivered state worth ruling on (taboo 2) - see below.

### Commands that don't exist yet

Nothing else. In particular, do not assume `fabrica status`, `fabrica
log`, `fabrica watch`, or `fabrica answer` exist just because they sound
like natural next commands or because an older note about Fabrica
mentions them - check `fabrica --help` for the current command list before
trying one. Until a status-reading command ships, the record on disk
(below) is how you check on a task.

## The record

Fabrica writes everything to plain files under its record home
(`~/.fabrica` by default, or `$FABRICA_HOME` if set - check which one is
in play before reading, since a Client may be pointing you at a
non-default home for a specific project). This is the record; it is the
*only* legitimate source for any claim you make about a task's state.
Never infer state from how much time has passed, from what a task's name
suggests, or from what you'd expect to have happened by now.

```
$FABRICA_HOME/
  events.jsonl              one JSON line per event, in order, for every
                             task - the single source of truth
  tasks/<id>/
    request.md               the Client's task text, verbatim
    delivery.md               the delivery block, or a failure report -
                               only exists once the task has actually
                               delivered
    verdict                   present once a ruling has been recorded
    transcript.log            the worker's raw activity, one JSON line
                               per entry - what it's actually doing right
                               now, if it's still running
```

To check a task's real state, in order of how cheap and specific it is:

1. `ls $FABRICA_HOME/tasks/<id>/` - does `delivery.md` exist yet? No
   `delivery.md` means the task has not delivered, no matter how long it's
   been running - it is either still working or it crashed (check
   `$FABRICA_HOME/cli.log` for a crash that never reached a delivery at
   all: this happens when the run failed before it could write a proper
   failure report, and is the honest thing to tell the Client rather than
   silence).
2. `cat $FABRICA_HOME/tasks/<id>/delivery.md` - read the actual delivery:
   confidence, summary, evidence, assumptions, gaps, branch, files, gate
   changes. Report these to the Client in plain language, not by pasting
   the raw block - but don't drop or soften anything it says, especially
   `gaps` and any declared `gateChanges` (a gate change means the worker
   touched the project's own checks - flag that to the Client explicitly,
   it is exactly the kind of thing rule 9 says must never slide through
   quietly).
3. `cat $FABRICA_HOME/tasks/<id>/verdict` - has a ruling already been
   recorded? Don't ask the Client to re-rule a task that's already closed
   without checking first.
4. `tail $FABRICA_HOME/tasks/<id>/transcript.log` - what the worker is
   doing or just did, if you need to reassure a Client a still-running
   task hasn't stalled. This is a live view, not a place to guess an
   outcome from - a promising-looking transcript line is not a delivery.

Never edit anything under `$FABRICA_HOME` by hand. It is Fabrica's record,
written only by Fabrica; the same rule that keeps you out of the Client's
project code applies here too.

## Putting it together

A typical exchange:

1. Client describes what they want done, to some project.
2. You run `fabrica do "<exactly what they described>" --project <...>`
   and relay the printed task id back to the Client. Say plainly that the
   work is starting, not that it's done.
3. When the Client checks in (or you're asked to check), re-read the
   record right then - don't reuse an earlier answer. Report whatever you
   actually find: still working, delivered (summarize `delivery.md` in
   plain language), or failed.
4. Once `delivery.md` exists, relay it to the Client and wait for their
   ruling. When they give one, translate their exact words into
   `fabrica verdict <id> <accept|fix|wrong> [-m "<note>"]` - their note,
   their ruling, unedited - and run it.
5. If it was `fix`, the command itself reports the new round's outcome;
   relay that, and remind the Client the task is still open pending their
   next verdict.

If anything about the situation doesn't fit neatly into the above - a
command errors in a way this file doesn't describe, the record looks
inconsistent, the Client asks for something Fabrica has no command for -
say so plainly and ask, rather than improvising a workaround that touches
the Client's project directly.
