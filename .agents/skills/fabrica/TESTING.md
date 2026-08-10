# How this handbook was tested (fabrica#14)

The issue's bar for "done": a fresh chat session, given only `SKILL.md`,
drives a full task correctly. This file is that transcript, re-run after
`fabrica status`/`log`/`watch` (issue #12) landed and the handbook was
rewritten against the real, current command surface - the original
two-command version was tested once already; this replaces that run
rather than sitting alongside it, since the six-command handbook needed
its own proof.

## Setup

- A throwaway fixture git repo (`math.js` with only `add()`, plus a
  `check.sh` that also requires `subtract()`).
- A throwaway `FABRICA_HOME` (nothing pre-existing in it).
- `fabrica` installed for real via `npm link` and run as the actual
  installed binary - not a test harness, not a fake brain.
- A brand-new agent (Claude Code's `general-purpose` subagent), told to
  read only `SKILL.md` - explicitly instructed *not* to read `SPEC.md`,
  `CONTRACT.md`, any `README.md`, or Fabrica's source - and given a
  Client request in plain language: *"Add a subtract(a, b) function to
  math.js that returns a minus b, and export it alongside add. Use
  fabrica for this - don't edit the file yourself."* It was also told to
  exercise `status`, `log`, and `watch` at least once each against the
  real task, and not to use any background wait/poll tool - since the
  underlying credential gap (below) now makes every task fail within a
  couple of seconds, nothing in this run needed a long wait.

## What the fresh agent actually did, in order

1. Read `SKILL.md`.
2. Ran `fabrica --help` and `fabrica do --help` to confirm the handbook's
   command list and shapes against the real CLI before trusting them -
   both matched exactly.
3. Ran `fabrica do "Add a subtract(a, b) function to math.js that returns
   a minus b, and export it alongside add." --project <fixture path>` -
   the Client's own words, not a paraphrase - and did not touch `math.js`
   itself.
4. The command printed the task id to stdout, then reported on stderr
   that the task failed before any work started (`Not logged in · Please
   run /login`), exit code 1 - the handbook's documented third outcome of
   `do`, not the "asking" or "started" ones. The agent correctly did not
   read exit-1-with-a-task-id as "the request was bad" - it reported the
   real reason instead.
5. Ran `fabrica status`: one line, `<taskId>  unknown project  failed
   5s old`. Correctly noted the id and state rather than assuming
   anything from the command's earlier exit code.
6. Ran `fabrica log <taskId>`: two events, `task-received` then
   `ask-failed` with the real error text - matched what `do` had already
   reported.
7. Ran `fabrica watch <taskId>`: printed the handbook-documented terminal
   notice for a task that failed before any delivery ("no `fix` path;
   `fabrica log` has the reason") and returned on its own immediately -
   no timeout or interrupt needed, since a `failed`-with-no-delivery task
   is one of `watch`'s two terminal states.
8. Re-ran `fabrica status` once more before reporting, confirming the
   state hadn't changed since the last check (taboo 2), then gave the
   Client a plain-language report: the request was handed to Fabrica, it
   failed before any work started for a credentials reason unrelated to
   the request itself, nothing touched the project, there's no `fix` path
   since nothing delivered, and it named the exact task id for follow-up.
   It did not fabricate a delivery and did not fix `math.js` itself.

## What this does and doesn't prove

**Proves cleanly:** taboo 1 (never touched the fixture file), taboo 2
(every status claim backed by a command run that same turn, including the
final re-check before reporting), and correct real-CLI use of `do`,
`status`, `log`, and `watch`, including `do`'s "failed before any work
started" outcome and `watch`'s auto-stop-on-terminal-state behavior -
none of this existed at the time of the first test run.

**Doesn't cover:** `fabrica answer` (no task ever reached the "asking"
state to answer) and a clean `accept`/`fix`/`wrong` verdict round, because
no task reached a delivered state to act on either way. Verified instead
by direct source reading (`answer-args.ts`, `answer-command.ts`,
`verdict-args.ts`, `verdict-command.ts`) and, for `verdict`/`answer`'s
refusal paths on an undelivered/unasked task, by running both commands by
hand against the same failed task and confirming their exact refusal text
(`"has not been delivered yet"`, `"never asked a clarifying question"`).
Also doesn't cover auto-discovery: this run handed the fresh agent
`SKILL.md`'s path directly. The `.claude/skills/fabrica` symlink that lets
Claude Code find it on its own was verified only by resolving it (it reads
back `SKILL.md`/`TESTING.md`), not by a session that loaded the skill
unprompted.

**Why the same gap as before:** `src/brain/adapters/claude-code.md`'s
"Process containment" section - the reference brain adapter always runs
inside a throwaway Docker container with no credential configured, so
`claude auth status` inside it reports "Not logged in." What changed since
the last test: every task's first pass now calls `brain.ask()` before any
work begins (issue #8, already on `master` when this handbook was first
written but exercised for the first time by this run), so a task hits this
gap even faster than before - at the clarifying step, before a
ProductionLine is ever cut, rather than partway into a worker run. Every
real task run through `fabrica do` fails at this same step today,
regardless of what it asks for. Closing that gap is a live-credential
decision for whoever configures Fabrica, not a documentation fix.
