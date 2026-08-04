# The brain socket

A `Brain` is an AI coding agent, driven non-interactively: it takes plain
instructions, does the actual work inside a copy of the project, and
reports back what it did. Fabrica calls this a "brain," LANGUAGE.md's
term for the model inside a worker. Everything outside this folder talks
to a `Brain` only through the shape below - it never knows or depends on
which agent is actually behind it. That's CONTRACT rule 8; see
[`adapters/README.md`](./adapters/README.md) for where a real one lives,
including concrete candidates.

## `name` and `model`

Two separate labels, because they answer different questions.

- `name` identifies the adapter itself, not the model it's driving.
  Concretely: a fixed string the adapter's own code sets, such as
  `"terminal-cli"` for one adapter or `"model-api"` for another.
- `model` identifies which underlying model that adapter is currently
  using, such as whatever version string that model reports itself as.

They're split apart because one adapter can often be pointed at more than
one model. `name` stays fixed; `model` is what changes if you switch
which model that same adapter drives, without touching anything outside
the adapter.

## `work(instructions, workdir, opts?)`

This is the one call the rest of Fabrica ever makes. Everything a brain
does happens inside it.

- `instructions` is the task, in plain text - what the worker is being
  asked to do, written the way you'd write it for a person.
- `workdir` is a throwaway copy of the project, never the Client's real
  checkout (CONTRACT rule 1). The brain is free to make a mess, run
  commands, edit anything in there - the folder gets torn down after, and
  nothing it does can reach the original.
- By the time the returned promise resolves, the brain is expected to
  have actually done the work described in `instructions` inside
  `workdir` - not planned it, not described it back. Fabrica checks the
  result next by running the project's own checks against that folder.

## `opts.session` - warm sessions

Pass a prior session id here to mean "keep going with the worker who was
just doing this," not "start someone new."

This exists because a fresh worker starts blank: no memory of what it
just tried, what failed, or why. That's wasteful and often wrong - the
fastest way to fix a mistake is to tell the same worker exactly what went
wrong and let it correct itself, not restart it from zero.

- Pass it: the brain resumes that session's own context and treats
  `instructions` as a correction inside it - "here's what failed, fix
  it" - not a new task.
- Leave it out: the brain starts cold, with no prior context at all.

## `opts.effort` - how hard to try

A free-form hint about how much effort to spend, such as `"low"`,
`"high"`, or an adapter-specific value like `"reasoning: max"`. It's a
plain string on purpose, not a fixed `low | medium | high` set - a closed
list would force every caller to speak whichever adapter's vocabulary
happens to be plugged in today.

Two rules follow directly from that choice, and both are load-bearing:

- **An adapter that doesn't recognize the value must ignore it, not
  fail.** A task can never break just because a caller asked for an
  effort level some tool has never heard of.
- **The value is recorded as requested regardless.** Even when an
  adapter ignores it, what was asked for still lands on the receipt - so
  the record shows the intent, not just what the adapter happened to do
  with it.

Leave it out and the adapter picks its own default effort.

## `transcript`

The raw record of what the brain did during this call. It's what a human
watching the worker sees - `fabrica watch` streams it live, and it's what
`fabrica log --transcript` shows after the fact. Nothing downstream
parses it to make decisions; it's for a person to read.

## `gateChanges`

A worker is allowed to change the project's own tests or check settings -
sometimes that genuinely is the task. What's never allowed is doing it
silently. This field is how a brain declares the change explicitly:
which check changed, and why the instructions called for it.

Leaving the field out means exactly one thing - the gate was left alone.
There's no other way to say "no changes here." This file only carries the
declaration through the socket faithfully; deciding whether a given
declaration is acceptable is CONTRACT rule 9's job, handled elsewhere,
not here.

## `session` on the way back

The id for whatever session just ran. Hand this back in as `opts.session`
next time to keep talking to the same worker instead of starting over.
It's also written onto that attempt's receipt, so the record shows which
session produced which result.

## Writing an adapter

A real adapter is anything that implements `Brain` honestly: pick a
`name`, report the `model` it's actually using, and make `work()` really
do the requested work inside `workdir`, returning a transcript and, when
they apply, a session id and a gate declaration. See
[`adapters/README.md`](./adapters/README.md) for concrete candidates and
a sketch of the shape.

The one hard rule: no brain, model, or vendor name may appear anywhere
under `src/` except inside `src/brain/adapters/`. That's not a style
preference - a test enforces it on every build.
