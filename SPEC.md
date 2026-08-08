# SPEC — Fabrica, version one

`fabrica` is the name of the workhorse: a terminal tool that takes a
written task, does the work in isolation using a coding agent, verifies it,
and delivers honestly. The name is disposable; rename freely.

This spec is a hypothesis of the smallest useful version. Expect it to be
edited after the first build attempt. CONTRACT.md is not a hypothesis:
every invariant there must hold in this version and every future one.

Version one contains **no strategies**. One task at a time, one attempt,
ask-first. Fan-out, judging, model routing, self-experimentation: all
deliberately absent. They arrive later as playbook entries; nothing in
this design may make them hard to add (that is what the adapter seam and
the event log are for).

## Form

- A command-line tool written in TypeScript, running on Node 20+.
- Installed so that `fabrica` works from any directory.
- No screens, no daemon in v1. Every command starts, does its job, exits.
  (Long work runs detached; see `fabrica do`.)
- Workers are invisible by default and watchable always. Every worker's
  transcript is a sequence of structured entries — each with its own
  timestamp, a kind, and its text — appended to its transcript file live
  as they land; the live text stream `fabrica watch` (or your own tail
  of that file) shows is rendered from those entries, so it shows
  exactly what a worker is doing right now. Views never control: closing
  one touches nothing.
- The coding agent that performs work inside the box is a subprocess
  behind a small adapter interface: the `Brain` seam, whose ratified
  shape lives in `contract/surface.ts` and whose src-side home is
  `src/brain/`. v1 ships one adapter: whichever terminal coding agent the
  Client already uses daily, invoked in its non-interactive mode. The
  adapter's exact invocation is discovered and verified during the build,
  not assumed here. Nothing outside the adapter may know which agent is
  in use. Adapters support warm sessions (adopted Aug 2026): every run
  carries a session id, and a retry is a correction message into the
  same session — naming exactly what failed — never a cold restart that
  throws away what the worker just learned. The session id lands on the
  receipt.

## Commands

### `fabrica do "<task text>" --project <path-or-name>`
The whole tool in one command.

1. **Registers** the task: new id (`YYYYMMDD-<slug>-<2 random chars>`),
   task text saved verbatim, event logged.
2. **Clarify-or-proceed (ask-first dial, v1 position: ask).** The agent's
   first pass produces either QUESTIONS or a short PLAN:
   - If the task is materially ambiguous → print numbered questions and
     stop. The Client answers with `fabrica answer <id> -m "<text>"`, which
     appends a round to `answers.md` and re-derives `brief.md`, then
     resumes at this step. The brief is the Client's original request
     plus every answer given so far, assembled into the one document a
     Worker actually receives — it is exactly what a brain gets as the
     `brief` argument of `Brain.work`. See "The record" below for how
     the request and its answers are kept apart on disk. One
     clarification round by default; `--just-go` skips this step.
   - Otherwise → proceed. The plan goes in the record, not to the screen.
3. **Isolates.** Creates a disposable git worktree of the project on a
   fresh branch `fabrica/<id>`. The Client's checkout is never touched
   (Contract 1).
4. **Works.** Runs the agent adapter in the worktree with the brief.
   Detached from the terminal: `fabrica do` prints the id and returns
   immediately; work continues in the background. Full agent output
   streams to the task's transcript file.
5. **Verifies.** Runs the project's check command (see Config below)
   inside the worktree. Green → delivery. Red → one fix pass by the agent
   with the failure output, then re-check. Still red → failure report
   (Contract 2). The counts here (one fix pass) are code, not judgment
   (Contract 3).
6. **Delivers.** Writes `delivery.md` (block format below), prints it,
   and leaves the branch in place for review. v1 never pushes, never
   opens a pull request. The Client merges or discards by hand.
7. **Nags for a verdict** on later `fabrica` invocations until one is recorded
   (Contract 6).

### `fabrica answer <id> -m "<text>"`
Appends a clarification round to `answers.md` and re-derives `brief.md`
from `request.md` plus every answer so far, then resumes the task. Never
writes into `request.md` — the Client's original words stay verbatim.

### `fabrica verdict <id> <accept|fix|wrong> [-m "<note>"]`
Records the Client's ruling (Contract 6). `fix` = right direction,
needed correction. `wrong` = should not have been attempted this way.
The note is free text and is the most valuable training signal captured.

### `fabrica status`
One line per open task: id, project, state
(asking | working | checking | delivered | failed), age.

### `fabrica log <id>`
Prints the task's full event history; `--transcript` includes the raw
agent output.

### `fabrica watch <id>`
Live view of a worker: streams the task's transcript to your terminal
as it is being written — in any terminal, any window manager, or a
herdr/tmux pane if that's where you run it. Stopping the watch (Ctrl-C)
never stops the work. Watching is a window onto the worker, not the
room the worker lives in.

## The record

Plain files, human-readable, at `~/.fabrica/` (path configurable):

    ~/.fabrica/
      events.jsonl            # append-only; every event, one JSON line:
                              # {occurredAt, taskId, name, details}
      tasks/<id>/
        request.md            # the Client's words, verbatim; written once,
                              # never appended to
        answers.md            # one section per clarification round: the
                              # question asked, the answer given
        brief.md              # assembled from request.md plus every answer
                              # so far — what a Worker actually receives as
                              # Brain.work's `brief` argument
        plan.md               # agent's plan (when it proceeded)
        delivery.md           # the delivery block, or failure report
        verdict               # accept|fix|wrong + note + occurredAt
        transcript.log        # the worker's structured transcript entries,
                              # one JSON line each; `fabrica watch` renders
                              # the live stream from them
        worktree/             # the ProductionLine while the task runs;
                              # removed when it is destroyed (the branch stays)
      projects.toml           # project registry + caps (below)

Files, not a database, in v1: the Client must be able to read, grep, and
diff the record with bare hands, and later organs (learning, status,
Amy) read the same files. `events.jsonl` is the single source of truth;
everything else, including `brief.md`, is a convenience view of it
(Contract 5) — `brief.md` could be derived on every read instead of
written to disk, but writing it keeps the record readable with bare
hands, which this section requires of everything under the record home.

Keeping `request.md` and `answers.md` apart, rather than appending
answers onto the request as earlier drafts of this spec did, preserves a
fact worth keeping: whether a task needed clarification at all, and how
much. That signal feeds Contract rule 4's assumptions field (sharper
when it's visible which parts of the brief were original versus added
because the Worker had to ask), Phase 5's re-attempt-and-grade work
(#30-#33), and later confidence calibration (#33), all of which want to
compare outcomes against how ambiguous the original request was —
information a single merged file destroys.

## Config

`projects.toml` in the record home holds two things: the project registry
and the caps, each under its own top-level table. Projects live under
`[projects.<name>]`; the caps get their own table, in dollars (Contract 10):

    [caps]
    perTaskUsd = 2.5
    perDayUsd  = 20

    [projects.spending-app]
    path  = "~/inkling-umbrella/spending-app"
    check = "bin/ci"        # the ONE command that must pass for green

A leading `~` in `path` expands to your home directory when the config
loads, so the example above works exactly as printed. Only a leading `~`
or `~/`; `~user` is not supported, and a `~` elsewhere in the path is a
literal character.

If `check` is missing for a project, `fabrica do` refuses the task and says
exactly what to add. No check command, no verified work, no exceptions
(Contract 2). A task naming a project with no entry at all is refused the
same way, naming the project and the entry to add.

Every top-level table is either `[caps]` or `[projects.<name>]`; anything
else is refused with exact instructions to move it under `[projects.<name>]`.
Because projects and caps no longer share a namespace, a project may be
named `caps` — `[projects.caps]` is a project like any other. Zero is a
legal cap, not an absent one.

## The delivery block

`delivery.md`, exact required fields (Contract 4):

    confidence: 0-100
    summary:    what was done, plainly
    evidence:   the check command, its result, plus any extra proof
                (commands + outcomes)
    assumptions: every judgment call made where the brief was silent
    gaps:       what was not done, or remains confusing
    branch:     fabrica/<id> in <project path>
    files:      files touched
    gateChanges: declared gate changes (Contract 9), empty when the
                gate was left alone

A delivery missing any field must not be presented.

## The operator's skill

The tool ships with a manual written for agents, not humans (a "skill"):
what the tool is, the exact commands with examples, how to read the
record, and the taboos — never do the work yourself, never touch the
record by hand, pass the Client's numbers through verbatim, never
announce state you didn't query. Whatever AI the Client talks through loads this first, so plain
Client-talk drives the levers the same correct way whichever brain is
doing the talking. Safety comes from the code;
competence comes from the manual.

## Catching off-the-books work

The AI you talk to must never do work itself, and two nets enforce and
measure that. **Prevention, where the harness allows it:** the skill
folder ships a per-harness session setup that switches off file-editing
tools for the session you talk to — real settings, not instructions —
and narrows which terminal commands that session may run to the tool's
own commands plus read-only ones. **Detection, always:** every time any
tool command runs, the tool checks each registered project for changes
that no task explains — code changed, nothing on the record — and logs
an `unattributed-change` event with project, files, and time. Where the
harness supports event hooks (Claude Code does), the session setup also
logs every blocked edit attempt as an `edit-attempt-blocked` event.
Both events are improvement signals, and both surface in Phase 4's live
view. Deliberately small — one config folder plus one cheap check —
until living with the tool shows how common the problem actually is.

## Out of scope for v1 — explicitly

Multiple attempts and judging; model selection or switching; a status
dashboard beyond `fabrica status`; pushing or opening pull
requests; running more than one task per project at a time (parallel
tasks across different projects: allowed, it falls out of isolation);
voice anything; playground/self-experimentation. The event log is
designed so all of these can be added without reshaping the record.

## Definition of done for the v1 build

1. Every CONTRACT.md invariant has its named test, and all tests pass.
2. On a real repository: `fabrica do` with a vague task produces questions;
   `fabrica answer` resumes it.
3. On a real repository: `fabrica do` with a clear small task produces a
   verified branch and a complete delivery block, without touching the
   Client's checkout.
4. A task with a deliberately broken check produces a failure report,
   never a "done."
5. `fabrica verdict` records, and `fabrica status` / `fabrica log` reflect reality.
6. The Client has run one real task of his own through it, end to end,
   verdict included.
