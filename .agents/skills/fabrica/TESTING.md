# How this handbook was tested (fabrica#14)

The issue's bar for "done": a fresh chat session, given only `SKILL.md`,
drives a full task correctly. This is the transcript of that test.

## Setup

- A throwaway fixture git repo (`math.js` with only `add()`, plus a
  `check.sh` that also requires `subtract()`).
- A throwaway `FABRICA_HOME` (nothing pre-existing in it).
- `fabrica` installed for real via `npm link` and run as the actual
  installed binary - not a test harness, not a fake brain.
- A brand-new agent (Claude Code's `general-purpose` subagent), told to
  read only `SKILL.md` - explicitly instructed *not* to read
  `SPEC.md`, `CONTRACT.md`, any `README.md`, or Fabrica's source - and
  given a Client request in plain language: *"Add a subtract(a, b)
  function to math.js that returns a minus b, and export it alongside
  add. Use fabrica for this - don't edit the file yourself."*

## What the fresh agent actually did, in order

1. Read `SKILL.md`.
2. Ran `fabrica --help`, `fabrica do --help`, `fabrica verdict --help`
   to confirm the handbook's command shapes against the real CLI before
   trusting them.
3. Ran `fabrica do "Add a subtract(a, b) function to math.js that
   returns a minus b, and export it alongside add." --project <fixture
   path>` - the Client's own words, not a paraphrase, and did not touch
   `math.js` itself.
4. Correctly reported the task as *registered and running, not done* -
   did not treat the command returning as the task finishing.
5. Checked the record (`ls tasks/<id>/`) immediately after - no
   `delivery.md` yet - and, rather than guessing, set up a wait/poll
   strategy for a real answer instead of assuming a quick failure meant
   the task was stuck, or that a quiet directory meant success.
6. When re-prompted to stop waiting and check the record directly
   (a scripted nudge to force the "query now, not from memory" path -
   see caveat below), it re-ran three fresh commands and reported
   exactly what they showed:
   - `ls tasks/<id>/`: only `brief.md`, `request.md`,
     `worktree.fabrica-session` - **no `delivery.md`**.
   - `events.jsonl`: `task-received`, `work-started`, and nothing
     after.
   - `cli.log`: `fabrica do: task on "..." failed: Not logged in ·
     Please run /login`.
7. Reported, in plain language, that the task never delivered, that
   this was an authentication problem with the worker adapter and not a
   problem with the `subtract` request itself, that it would not fix
   this itself (the handbook's first taboo), and that no verdict applies
   because nothing delivered (the handbook's record-reading guidance).
   It did not fabricate a delivery, did not guess the task had "probably
   worked by now," and named the exact task id for follow-up.

## What this does and doesn't prove

**Proves cleanly:** taboo 1 (never touched the fixture file itself, ran
`fabrica do` instead), taboo 2 (repeatedly re-queried the real record
instead of assuming; the final report cites the literal command output,
not a remembered state), and correct use of both documented commands'
argument shapes, verified against the real CLI.

**Doesn't cover:** a clean `accept`/`fix`/`wrong` verdict round (taboo
3's exact-numbers-through), because the task never reached a delivered
state to rule on.

**Why:** a pre-existing, already-documented gap, unrelated to this
issue - `src/brain/adapters/claude-code.md`'s "Process containment"
section: the reference brain adapter always runs the coding agent inside
a throwaway Docker container, and that container has no credential
configured yet (verified live here too: `claude auth status` inside it
reports "Not logged in"). Every real task run through `fabrica do` fails
at this same step today, regardless of what the task asks for. Closing
that gap is a live-credential decision for whoever configures Fabrica,
not a documentation fix - see that file for the full reasoning. It is
called out again in the CONTRACT/AGENTS-facing summary of this work
rather than worked around here.

One honest caveat about the test itself: step 6 above was a scripted
nudge from the person running this test ("stop waiting, check the record
now") rather than the fresh agent independently deciding to stop
waiting on its own after its background monitor idled out without
resolving. What it did *after* that nudge - which three commands it
ran, and reporting only what they actually showed - was the agent's own
judgment, using the handbook's record-reading guidance, not scripted.
