# The brain socket

This is where a mind plugs into Fabrica. Everything outside this folder
talks to a `Brain` only through the shape below - it never knows or cares
which one is actually thinking. That's CONTRACT rule 8; see
[`adapters/README.md`](./adapters/README.md) for where a real one lives.

## `name` and `model`

Two separate labels, because they answer different questions.

- `name` identifies the adapter itself - the plug, not what's behind it.
  Concretely: the string an adapter's own code chooses for itself.
- `model` identifies which mind that adapter is currently driving.

They're split apart because one adapter can often be pointed at more than
one model. `name` stays fixed; `model` is what you'd change to try a
different one, without touching anything that isn't the adapter.

## `work(brief, workdir, opts?)`

This is the one call the rest of Fabrica ever makes. Everything a brain
does happens inside it.

- `brief` is the task, in plain text - what the worker is being asked to
  do, written the way you'd write it for a person.
- `workdir` is a throwaway copy of the project, never the Client's real
  checkout (CONTRACT rule 1). The brain is free to make a mess, run
  commands, edit anything in there - the folder gets torn down after, and
  nothing it does can reach the original.
- By the time the returned promise resolves, the brain is expected to have
  actually done the work described in `brief` inside `workdir` - not
  planned it, not described it back. Fabrica checks the result by running
  the project's own checks against that folder next.

## `opts.session` - warm sessions

Pass a prior session id here to mean "keep going with the worker who was
just doing this," not "start someone new."

This exists because a fresh worker starts blank: no memory of what it just
tried, what failed, or why. That's wasteful and often wrong - the fastest
way to fix a mistake is to tell the same worker exactly what went wrong
and let it correct itself, not restart it from zero.

- Pass it: the brain resumes that session's own context and treats
  `brief` as a correction inside it - "here's what failed, fix it" - not a
  new task.
- Leave it out: the brain starts cold, with no prior context at all.

## `transcript`

The raw record of what the brain did during this call. It's what a human
watching the worker sees - `fabrica watch` streams it live, and it's what
`fabrica log --transcript` shows after the fact. Nothing downstream parses
it to make decisions; it's for a person to read.

## `gateChanges`

A worker is allowed to change the project's own tests or check settings -
sometimes that genuinely is the task. What's never allowed is doing it
quietly. This field is how a brain declares it out loud: which check
changed, and why the brief called for it.

Leaving the field out means exactly one thing - the gate was left alone.
There's no other way to say "no changes here." This file only carries the
declaration through the socket faithfully; deciding whether a given
declaration is acceptable is CONTRACT rule 9's job, handled elsewhere, not
here.

## `session` on the way back

The id for whatever session just ran. Hand this back in as `opts.session`
next time to keep talking to the same worker instead of starting over.
It's also written onto that attempt's receipt, so the record shows which
session produced which result.

## Writing an adapter

A real adapter is anything that implements `Brain` honestly: pick a
`name`, report the `model` it's actually using, and make `work()` really
do the brief inside `workdir`, returning a transcript and, when it applies,
a session id and a gate declaration.

The one hard rule: no brain, model, or vendor name may appear anywhere
under `src/` except inside `src/brain/adapters/`. That's not a style
preference - a test enforces it on every build. See
[`adapters/README.md`](./adapters/README.md) for the full boundary.
