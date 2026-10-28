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
  An adapter that was given no model to use says so honestly -
  `model.ts`'s `UNKNOWN_MODEL`, never a word like "default" that reads
  as a real choice (issue #184) - and the model each call really ran is
  reported per call, on the reserved `"model"` transcript entry below.

They're split apart because one adapter can often be pointed at more than
one model. `name` stays fixed; `model` is what changes if you switch
which model that same adapter drives, without touching anything outside
the adapter.

## `ask(brief)` — SPEC.md step 2, "Clarify-or-proceed" (issue #8)

Called once, before any ProductionLine exists, with only the bare task
text - no `workdir`. It's the brain's one pass at deciding whether
`brief` is *materially ambiguous*: an ambiguity that would change what
actually gets built, not something a reasonable person would fill in the
same way every time. Getting this wrong in the cautious direction is its
own failure - a brain that asks about everything makes the tool nobody
wants to use - so drawing that line narrowly is the brain's job, not
something callers second-guess.

Returns `{ question?: { question, options } }` (issue #176). One question
means "stop and ask this"; omitted (or `null`) means "clear enough,
proceed to `work()`."

**The shape is fixed, and Fabrica enforces it at dispatch**
(`ask-shape.ts`, the one copy of these rules - an adapter asks its brain
for exactly this, and the Foreman checks exactly this):

- Exactly **one** question. More than one thing unclear means asking
  about the one that would change what gets built the most; the rest can
  be decided while the work runs.
- **Two to four options**: the answers the brain thinks most likely, each
  a short phrase.
- **No "other" of the brain's own.** Fabrica appends `OTHER_OPTION` to
  every question, and the Client can always answer in his own words; a
  brain that includes its own is rejected rather than silently given two.
- The ratified free-form `questions?: string[]`
  (`contract/surface.ts`) is **itself a rejection** now. It is still
  declared, so a brain *can* send it - and will be told the shape and
  asked again.

Anything out of shape is turned away with a reason, recorded as
`"ask-rejected"`, and the brain is asked again inside the same pass -
twice at most, after which the pass fails loudly
(`ForemanError("ask-shape-invalid")`). Every one of those calls spends
money, so every one of them records its own cost. An adapter should
therefore pass a wrong-shaped ask through **untouched** rather than
tidying it up: tidying makes the re-ask unreachable and hides the one
thing the shape rule exists to catch. Output that is not an ask attempt
at all (unparseable junk) still reads as "nothing to ask" - see the
reference adapter's `parseAskResult`.

Fabrica derives a **stable id** for every question from its own text plus
its options (issue #175: `deriveQuestionId`, a hash - a brain never
supplies one, so two different questions can never collide on one), and
the first answer to that id wins for the rest of the task: a question
that comes back is answered from the record instead of being put to the
Client twice.

No `workdir` is a deliberate part of the contract, not an oversight: it
means this call structurally cannot read or write anything of the
Client's, so CONTRACT rule 1 ("it never touches your stuff") holds here
by construction - there's nothing to trust a brain's own good behavior
about. It also means there's nothing to resume `work()`'s warm session
from: `ask()` never receives or returns a session id, and a real call
during `work()` never resumes one from a prior `ask()` either - see the
reference adapter's own doc for why a session can't cross that boundary
even if this interface tried to smuggle one through (it's scoped to the
`cwd` it was born in, and `ask()`/`work()` never share one).

## `work(brief, workdir, opts?)`

The other call the rest of Fabrica makes, and the one that actually does
the work. Everything a brain builds, edits, or runs happens inside it.

- `brief` is the task, in plain text - what the worker is being asked to
  do, written the way you'd write it for a person. It's the same
  document `src/record/README.md` calls the brief: the Client's request
  plus every answer so far, assembled into the one thing a worker
  actually receives.
- `workdir` is a throwaway copy of the project, never the Client's real
  checkout (CONTRACT rule 1). The brain is free to make a mess, run
  commands, edit anything in there - the folder gets destroyed after,
  and edits to its files never land in the original project. That is a
  guarantee about project state, not process containment on its own -
  real, OS-level process containment exists at `../containment/` (issue
  #44, Docker-based): a call runs in a fresh, throwaway container whose
  only writable mounts are `workdir` and, when the adapter persists a
  warm session, its own throwaway home directory, with network denied
  unless deliberately allowed (that module's README owns the exact
  rules and why). Each adapter wires this in itself rather than getting
  it for free from the
  `Brain` interface, because plugging it in means running the adapter's
  own tool *inside* a container image, which is adapter-specific
  plumbing (see the reference CLI adapter's own doc file under
  `adapters/`, "Process containment," for what that means there).
- By the time the returned promise resolves, the brain is expected to
  have actually done the work described in `brief` inside `workdir` -
  not planned it, not described it back. Fabrica checks the result next
  by running the project's own checks against that folder.

## `opts.session` - warm sessions

Pass a prior session id here to mean "keep going with the worker who was
just doing this," not "start someone new."

This exists because a fresh worker starts blank: no memory of what it
just tried, what failed, or why. That's wasteful and often wrong - the
fastest way to fix a mistake is to tell the same worker exactly what went
wrong and let it correct itself, not restart it from zero.

- Pass it: the brain resumes that session's own context and treats
  `brief` as a correction inside it - "here's what failed, fix it" -
  not a new task.
- Leave it out: the brain starts cold, with no prior context at all.

## `opts.reasoningEffort` - how hard to try

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

Leave it out and the adapter picks its own default effort. The same
value also lands on the receipt as `Receipt.reasoningEffort`, so the
record shows what was asked for.

## `transcript`

A list of `TranscriptEntry` objects: the record of what the brain did
during this call, in order. It's what a human watching the worker sees -
`fabrica watch` prints these entries live, as they reach the record
(issue #70): an adapter that can report entries as it produces them -
today's reference adapter - does so through `src/brain/live-transcript.ts`'s
`emitLiveTranscriptEntry`, keyed on `workdir`, and the Foreman
(`src/foreman/attempts.ts`) forwards each one to the record the instant
it arrives rather than waiting for `work()` to resolve. A brain with no
finer-grained signal than "the whole call just finished" simply never
calls it - the Foreman still delivers every one of its entries, from the
return value, once that call resolves. Either way `work()`'s own return
value stays the complete, ordered transcript (nothing about `Brain`'s
contract changes), and `fabrica log --transcript` shows the same entries
after the fact. Nothing downstream parses an entry's `text` to make
decisions; it's for a person to read.

Each entry holds three fields:

- `occurredAt` - an ISO 8601 timestamp for when this piece of output
  happened.
- `kind` - what sort of chunk this is, such as `"stdout"`, `"tool-call"`,
  or `"reasoning"`. Deliberately a plain string, not a closed set, for
  the same reason `reasoningEffort` is: different tools categorize their
  own output differently, and a closed union would force every adapter
  to speak one vocabulary that may not fit what it actually emits.
- `text` - the content itself, in whatever form makes sense for that
  kind of chunk.

Three kinds are reserved, because `Brain.work()`'s ratified return shape
has no field for any of them and reshaping that seam for bookkeeping
would be a contract change: `"usage"` (rule 10's cost - see
`contract/surface.ts`) and, since issue #189, `"meters"`, whose text is
a `MeterReading` - both carrying JSON in `text` rather than prose - and,
since issue #184, `"model"` (`model.ts`'s `MODEL_TRANSCRIPT_KIND`),
whose text is plainly the name of the model that call actually ran, as
the brain reported it. Whatever assembles the Receipt reads all three
back out (`src/foreman/spend.ts`, `src/foreman/meters.ts`,
`src/foreman/model.ts`). Nothing else about an entry is ever parsed to
make a decision.

A per-call fact belongs on a reserved entry rather than on the `Brain`
object itself for a reason worth stating once: a `Brain` is built once
and can be shared by two tasks running in the same process, so a `model`
field the adapter rewrote as each call learned its real model would let
one task's receipt name the other task's model. `Brain.model` therefore
stays what it always was - a label for whatever the brain was configured
with, before any call - and is only ever a fallback for a brain that
reports nothing per call.

For example, an adapter running a tool call and reading its result might
produce:

```json
[
  { "occurredAt": "2026-08-04T12:00:01.000Z", "kind": "reasoning", "text": "Checking the failing test first." },
  { "occurredAt": "2026-08-04T12:00:02.000Z", "kind": "tool-call", "text": "read_file(check.sh)" },
  { "occurredAt": "2026-08-04T12:00:03.000Z", "kind": "stdout", "text": "#!/bin/sh\nexit 0\n" }
]
```

Structured entries exist instead of one raw string so a live view (Phase
4, #26) can render and expand each piece of output individually - a
single string can't give that back without the view re-parsing itself
apart from what the adapter already knew when it produced the output.
An adapter whose underlying tool already emits structured output (see
`adapters/README.md`'s written adapters for a real one) maps each piece
to its own entry directly. A text-only adapter that only gets one blob of
output back wraps that whole blob as a single entry - one array element
is a valid transcript, never an error.

## The subscription meters: `meters.ts` (issue #189)

A second workdir-keyed side channel, built exactly like
`relay-health.ts` above and for the same reason: an adapter has
something the Foreman needs *during* a call, and `Brain`'s ratified
signature (brief/workdir/opts) must not grow a parameter for it.

What it carries is a `MeterReading` - how much of the model provider's
5-hour and 7-day windows this account has used, as percentages of each
window, with the time the reading was taken. Either may be `null`,
which means "nobody could say", never 0%: an unreported quota and an
empty one are opposite facts, and everything downstream treats null as
"refuse nothing".

An adapter that can report them calls `registerMeterSource(workdir,
{ reading, pause })` for the life of its `work()` call:

- `reading()` answers with whatever has already arrived. It is called
  from the Foreman's heartbeat timer, so it must not throw, must not
  block, and must not go and ask anybody - it reports, it does not
  fetch.
- `pause()` stops that call's worker **gracefully**, and is what the
  Foreman calls when a meter is past its stop threshold. Deciding is
  deliberately not the adapter's job: the thresholds are the Client's,
  in `projects.toml`'s `[pause]` table, and
  `src/foreman/meters.ts` owns the rule.

An adapter that cannot report them registers nothing, and
`readMeters`/`pauseWorker` then honestly answer "unknown"/"nothing to
ask" - a `Brain` is complete without this.

Where the numbers actually come from is adapter-only knowledge (rule 8
again): the reference adapter reads them off the provider's own HTTP
response headers at the task's relay, since the worker CLI's own
non-interactive output carries neither number - see
the reference CLI adapter's own document under `adapters/`, and
`notes/20261020-do-fabrica-issue-189-as-written-closing-i3.md`. The
same reading is also pushed onto the transcript as a reserved
`kind: "meters"` entry (below), which is how it reaches the attempt's
receipt - the same trick `"usage"` already uses for cost.

## `gateChanges`

A worker is allowed to change the project's own tests or check settings -
sometimes that genuinely is the task. What's never allowed is doing it
silently. This field is how a brain declares the change explicitly:
which check changed, and why the brief called for it.

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

## Is the box's network still there? `relay-health.ts`

An adapter that stands a worker box up on a network of its own (both
written ones do: an isolated Docker network whose only route out is a
per-task relay container - `src/relay/`) registers a probe for this
call's `workdir`, through `src/brain/relay-health.ts`'s
`registerRelayHealthProbe`. The Foreman's heartbeat calls it on every
tick while `work()` is in flight and fails the attempt when it reports
that the relay is gone, naming it.

Same mechanism and same reasoning as `live-transcript.ts`: keyed on
`workdir`, the one value both sides already share through the ordinary
`Brain` interface, so nothing is added to a ratified signature and two
concurrent tasks never cross wires. Like live transcripts it is
entirely optional - an adapter that opens no network of its own
registers nothing, and the probe then reports no problem.

Answering is only half of what the written adapters do in theirs: a box
whose relay has died cannot finish, so they also stop it
(`runContained`'s `containerName`/`stopSignal`), which ends `work()`
in about a second with every teardown still on its ordinary path. Why
any of this exists: on 2026-10-18 a relay died mid-attempt, nothing
asked, and the task spent four minutes reporting heartbeats before the
box itself failed with a bare `ConnectionRefused`.

## Writing an adapter

A real adapter is anything that implements `Brain` honestly: pick a
`name`, report the `model` it's actually using, make `ask()` genuinely
judge ambiguity rather than always returning `{}`, and make `work()`
really do the requested work inside `workdir`, returning a transcript
and, when they apply, a session id and a gate declaration. See
[`adapters/README.md`](./adapters/README.md) for the written adapters,
further candidates, and a sketch of the shape.

The one hard rule: no brain, model, or vendor name may appear anywhere
under `src/` except inside `src/brain/adapters/`. That's not a style
preference - a test scans every build for a blocklist of the major
names. The blocklist is not exhaustive, so a name outside it would slip
past the scan; the rule still applies to every name, caught or not.
