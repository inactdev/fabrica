# The assistant may run a verdict the Client agreed to, and the record says so (issue #359)

## The decision, and the alternative rejected

`fabrica verdict` and `fabrica answer` are no longer denied to the chat
assistant. What keeps CONTRACT rule 6 true is no longer "the assistant
cannot run them" but "the Client agreed to it in his own message, and the
record says who typed it."

**Chosen shape: a boolean field on the two events that already exist.**
`verdict-recorded` and `answers-given` carry `viaAssistant: true` when the
assistant ran the command on the Client's instruction, and carry nothing
at all when he ran it himself (the same `...(cond ? { x: true } : {})`
idiom `supersedesRefusal`/`answersRefusal` already use on the same event).
Safest, in this order:

- It adds no member to `contract/surface.ts`'s `FabricaEventName` union,
  so the ratified, CI-protected contract is untouched.
- It defaults to "the Client's own." A detection that fails closed
  attributes his ruling to nobody but him; the field's absence is the
  pre-existing meaning of every event already on the record, so no
  backfill and no migration.
- Every existing reader of `verdict-recorded` keeps working unchanged
  (`queries.ts`'s `stateOf`, `quiz/staleness.ts`, `quiz/questions.ts`,
  `foreman/rebase-only.ts`, `foreman/meters.ts`, `integrations/herdr/`,
  the live view): a field they don't read is invisible to them.

**Rejected: a second event name** (`verdict-recorded-by-assistant`, or a
sibling `verdict-attributed`). It would mean editing `FabricaEventName` in
`contract/surface.ts` - which needs its own ruling and fails the
`block-protected-path-change` gate - and, worse, every one of the readers
listed above filters on the literal string `"verdict-recorded"`. A task
closed by a verdict the assistant ran would read as *still open* in
`fabrica status`, would never date a quiz question, and would never clear
a meter pause. A field on the existing event cannot have that failure
mode.

**Rejected: inferring the answer from whether stdin is a TTY.** AGENTS.md
already records that exact mechanism being weighed and rejected under
issue #76 - it blocks the Client's own legitimate scripted use and any
pty allocator defeats it. Reusing it as an *attribution* signal rather
than an enforcement one inherits both flaws in a worse place: his own
`fabrica verdict` from a script or a timer would be written down as the
assistant's.

## How the attribution is resolved

Clarification on issue #359: "Both: auto-detect, with a flag to override."

- **Auto-detect** is one environment sentinel, `FABRICA_ASSISTANT_SESSION=1`
  (`src/cli/assistant-session.ts`, the single home of the name). `fabrica
  up` puts it into the environment of the harness session it launches, and
  nowhere else - so every command the assistant spawns from inside that
  session inherits it and the Client's own terminal does not. This is why
  `HarnessLauncher.launch` gained an `env` parameter and
  `skill/<harness>/launch.ts` now passes it to its own spawn.
- **The flags override it in both directions**, on both commands:
  `--via-assistant` forces the mark on (for a harness `fabrica up` did not
  start), `--by-client` forces it off (for the Client typing in a shell
  that inherited the sentinel). Passing both is a usage error rather than
  a precedence rule - there is no sensible winner, and guessing one would
  write down an attribution nobody asked for.

The sentinel is an attribution signal, not a security boundary: anything
that can run `fabrica verdict` can also unset an environment variable.
That is the point - what makes an assistant-run verdict the Client's is
his own agreement in the conversation, which this records rather than
enforces.

## What is deliberately not marked

`verdict-failed` (issue #353) carries no `viaAssistant`. Its own interface
already states the principle: a ruling that never took effect has no
standing on the record, which is why it does not even carry the note. Who
attempted a ruling that was refused is not a thing the record needs to
tell apart.
