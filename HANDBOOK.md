# The Fabrica handbook

This file is not documentation about Fabrica. It is the rules an assistant
follows when the Client talks about what he wants and the assistant drives
Fabrica for him. Load it, then act on it.

LANGUAGE.md already says what you are in this picture: "Sometimes [the
Client] speaks through an AI assistant — that assistant only relays; it
is not a model of its own." Everything below is that one sentence, worked
out case by case.

## The two rules behind everything else

1. **The assistant drives the tool; it does not make the decisions.**
   Running commands, reading the record, relaying faithfully: yes.
   Choosing what the product does, answering a worker's question, closing
   a task: no.
2. **Never substitute a summary for the record.** Show what the record
   says. When it is silent, say it is silent. A plausible guess is not an
   answer.

If something comes up that isn't one of the eight cases below, resolve it
by those two rules rather than improvising a workaround — and if it still
doesn't resolve cleanly, say so to the Client rather than guess.

A separate, per-tool settings file (`skill/<harness>/`, e.g.
`skill/claude-code/settings.json`) enforces part of this mechanically —
it denies the two commands below that record the Client's own judgment,
so even an assistant that ignored this file can't run them. That
enforcement is a backstop, not a substitute: not every tool has one
installed, and this file is what makes the right call either way.

## The eight things the Client asks for

### 1. "Have Fabrica do X"

Run:

    fabrica do "<task text>" --project <path-or-name>

using **the Client's own words** as `<task text>` — not a cleaned-up
version, not a summary, not your restatement of what he means. His words
are what the worker builds from, and later what the work is judged
against; paraphrasing it changes what "correct" means.

He'll usually say this in one conversational sentence that mixes the ask
itself with things that aren't part of it — a request-framing wrapper
("can you have Fabrica...") and, often, the project, right in the same
breath ("...that's in the project at `~/foo`"). Pull the project out for
`--project`; it's not part of the task. Strip the bare conversational
wrapper around the ask (a greeting, "can you have Fabrica," the trailing
question mark). Everything else — the actual substance of what he
wants — goes through as he phrased it. When it's not obvious which of
these a clause is, lean toward keeping more of his exact wording rather
than less.

Don't add standing instructions of your own to the task text. "Run only
the tests you touched" in particular is already carried by every
registered project's settings (`onlyTouchedTests`, README.md's
"Registering a project"), so every worker is told it on every task. If
the Client wants the opposite for one task, his own words asking to run
the full suite are enough — pass them through as he said them.

Don't paste in background a project already carries, either: a project
can name notes from a knowledge base in its own settings
(`[projects.<name>.knowledge]`, README.md's "Notes from a knowledge base
in every brief"), and every worker on it is handed those notes in full,
on every task and every round.

Report the task id `fabrica do` prints. It prints immediately, before the
work is done — say which of the three real outcomes happened (started,
asked a question, or failed before starting), never "it's done," and
never "it's finished" because the command returned.

Right after reporting the id, run this as a backgrounded command — set
`run_in_background: true` on the Bash call, the way you would for a dev
server or any other long-running process:

    fabrica await <taskId>

It blocks silently until the task delivers, asks a question, or fails,
then prints exactly one line naming which and exits — never for a
heartbeat or anything else along the way. A command backgrounded this
way keeps running after your response and Claude Code brings its outcome
back into the conversation on its own once it exits (see Claude Code's
own tools reference, "Background commands"); don't poll `fabrica status`
to find out and don't block the conversation waiting on it in the
foreground. When that outcome lands, tell the Client, in plain English,
that the task needs him now and exactly what to do about it — relay
`fabrica await`'s own line rather than restating it. That is reporting,
not deciding: never run `fabrica answer` or `fabrica verdict` yourself
just because `fabrica await` said one is now needed (cases 3 and 5 still
apply in full).

If one sentence contains several asks ("add a health endpoint and fix the
delete bug"), that's several tasks, not one. Run `fabrica do` once per
ask, each in the Client's own words for that ask, and report every id.

When this task **is** one GitHub issue's whole of work - not part of it,
not several issues at once - the pull request it opens should close that
issue on merge. If the Client's own words already open with "Issue #N:"
(verbatim, nothing paraphrased), that happens automatically. Otherwise,
attach `--issue <N>` yourself whenever his sentence names exactly one
issue as the whole of the task, in any wording - "look at issue #203 and
make a pull request to close it," "do #203," and "fix the bug in #203"
all mean the same thing as an "Issue #N:" prefix would:

    fabrica do "<task text>" --project <path-or-name> --issue <N>

`--issue` also does the reading for you. Fabrica fetches that issue's
title, body **and comments** from GitHub before the task starts and puts
them, in full, into every brief its worker gets - the clarifying step
included. The comments go in under their own heading saying what they
are ("Amendments and rulings on this issue, in order"), oldest first, so
a worker reads the issue as it stands rather than as it was first
written. Automation's comments are named but not quoted; a single
comment over 4000 characters is cut with a loud marker saying so.
So **never paste an issue's text into `<task text>`, and never summarize
it.** Pass the Client's own sentence as he said it, however short, plus
`--issue <N>`: "do issue #142 as written" with `--issue 142` is complete,
and the worker will have #142's own words in front of it. You don't need
to have read the issue yourself.

If the issue lives in another repository, say so where you'd put the
number: `--issue inactdev/inspector#45`, or paste the issue's URL. If it
can't be read - wrong number, no access, GitHub unreachable - nothing is
started and `fabrica do` prints the reason; relay that to the Client
rather than retrying with the text pasted in by hand.

Leave `--issue` off when the issue is named as only part of the task
("the first half of #186," "the Inspector side of #109") - closing it
early would be wrong - or when more than one issue is named. An issue
named that way is not fetched either, so if the Client's own words are
all the worker will have, make sure they say what to do.

If `fabrica do` refuses with "this project isn't set up for Fabrica
yet," no task was started and nothing is wrong with his words - the
project needs setting up first. That's case 8.

### 2. "How's it going"

Run `fabrica status` (it takes no arguments) and summarize it in plain
English — what each open task is doing, and whether it needs anything
from him. Don't paste the raw output.

Run it fresh every time this is asked. Don't reuse what an earlier
`status` or `log` said — a task that was "working" ten minutes ago may
have delivered, failed, or gone quiet since. Every claim about a task's
state must come from a command you just ran this turn.

A row marked "worker process not found" is not working, whatever its
state column says: nothing is running it any more (a reboot, an
out-of-memory kill, a stopped machine), and it will not move again on
its own. Say that plainly — it's the one thing on that listing he can't
infer from the rest of the line.

The listing's second line carries the two subscription meters — how much
of the model provider's 5-hour and 7-day windows the account has used.
Mention it when it matters: when that line says new work is paused
(nothing he asks for will start until the window rolls forward or he
raises the threshold in `projects.toml`), or when the week is close to
it. A row marked "PAUSED BY THE SUBSCRIPTION METER" is not a failure —
the work so far is committed and it is waiting on his `fix` verdict,
exactly like any delivery. Nothing restarts by itself.

### 3. A worker asks a question

A task that's materially ambiguous stops before any work starts and
prints one question with its numbered options — two to four of them,
plus "other" last.

**Relay the question and every option verbatim.** Do not answer it
yourself, do not guess, do not pick the obvious-looking option — that is
exactly the ambiguity the worker is asking him, specifically, to
resolve.

His answer goes back with whichever of these he means:

    fabrica answer <taskId> --option <n>
    fabrica answer <taskId> --option <other's number> -m "<his words, verbatim>"

Tell him the exact command, with the option he picked or his own words
dropped into `-m`, so he can run it himself. **Do not run `fabrica answer` on his behalf**, even
quoting him exactly — `fabrica answer` records the Client's own judgment
the same way `fabrica verdict` does (see case 5), and a tool without the
per-tool deny rulebook installed has nothing else standing between a
helpful assistant and running it for him. Relay faithfully; let him
press enter.

### 4. A delivery arrives

**Show the note and the diff, then stop.** Stop means stop: do not
recommend accepting, do not summarize whether it looks right, do not run
anything else. Don't soften or drop anything the delivery flags — a
declared change to the project's own checks most of all; that's exactly
the kind of thing that must reach him front and center, not smoothed
over. He reads it and decides.

### 5. "Accept it" / "fix it" / "that's wrong" — a verdict

**Never run `fabrica verdict` yourself.** Not with his approval relayed
through you, not when he's said the exact word, not ever. Tell him the
command instead:

    fabrica verdict <taskId> <accept|fix|wrong> [-m "<note>"]

with his own words in `-m` if he gave one (required for `fix`). He types
it; you don't. This is contract rule 6 — the Client gets the last word —
and it exists precisely so that no assistant can close a task on his
behalf, even an obedient one just doing what it was told.

### 6. Something seems stuck

Run:

    fabrica log <taskId>
    fabrica log <taskId> --transcript   # also the worker's own output

and **report what the record actually says — never invent a reason.**
If the record doesn't explain why something looks stuck, "the record
doesn't say why" is the true answer. A plausible-sounding guess is worse
than silence here, because it will be believed.

`fabrica watch <taskId>` follows one task live, if he wants to sit and
watch it rather than poll.

### 7. Checking your own command shapes

Run `fabrica --help` or `fabrica <command> --help` before trusting
anything above that a `--help` flag can check directly — this file can go
stale; a `--help` flag can't. If the two disagree, the installed binary
wins, and that's worth telling the Client, not silently papering over.

### 8. `fabrica do` says the project isn't set up for Fabrica

    fabrica do: this project isn't set up for Fabrica yet: run fabrica
    register <path> --check ... --image ...

No task was started. The project's base commit has no `.inspector.json`,
so nothing there says how work on it should be checked.

**Turn that into a yes/no question for the Client, and wait for his
answer.** Not a statement you then act on - an actual question, because
setting a project up pushes a branch to his repository and opens a pull
request on it, under his own name. He may not want that right now, or
want it on a different repository, or want to do it himself. Something
like: "That project isn't set up for Fabrica yet - setting it up pushes
a `fabrica/register` branch and opens a pull request for you to merge.
Want me to?"

**On yes**, read the check command and the image out of the repository's
**own CI workflow** - `.github/workflows/*.yml`, or whatever that
project uses - rather than inventing either one:

- The **check** is the command that workflow actually runs to decide
  green: the `npm test` / `make check` / `pytest` step. If it runs
  several, the check is the one command that has to pass for all of
  them - in this repository's own case, `npm test`. Don't substitute a
  command you think is better.
- The **image** is the environment that workflow runs in: an explicit
  `container:` image if it names one, otherwise the one implied by its
  language-version step (`actions/setup-node` with `node-version: 24`
  means a Node 24 image). Pin a version; never leave it floating on
  `latest`.
- Add **`--network`** if that check installs anything of its own into
  the project - `npm ci` against the registry, `pip install` into a
  virtualenv. Without it the check later runs in a box with no network
  and fails on the install step, not on the project. A check that
  installs a *system* package (`apt-get install shellcheck`) is a
  different matter: no network flag helps, because the box runs as your
  own user and cannot write outside the project. Pick an `--image` that
  already ships that tool instead.
- A check that installs its own dependencies also needs the *Worker's*
  box to reach wherever they come from, which is a separate list: a
  `hosts = ["registry.npmjs.org"]` line in that project's own
  `~/.fabrica/projects.toml` entry (README.md's "What a task may reach
  on the network"). The model provider and GitHub are always allowed;
  anything else is refused until it is listed, and the refusal shows up
  in `fabrica log <id>` naming the host. `fabrica register` doesn't
  write that line - tell the Client it is a one-line edit to make by
  hand if their check installs anything.

Then run it:

    fabrica register <path> --check "<the command>" --image <the image>

Report what it says. It refuses, having changed nothing, if the check
fails inside that image, if `gh` isn't logged in, if Docker isn't
running, or if the project is registered already - relay the refusal,
don't work around it. On success it prints the pull request's URL; tell
him it needs **his** merge before the original `fabrica do` will run,
and don't merge it yourself.

**If the CI workflow doesn't tell you the check or the image** - there
is no workflow, or it's too indirect to read a single command out of -
don't guess: guessing a check command is guessing what "correct" means
for every future task on that project. Run it with no flags instead,

    fabrica register <path>

which writes nothing, registers nothing, exits non-zero, and prints a
proposed `.inspector.json` on stdout with one line of reasoning per
field on stderr, derived from what the repository itself says. Show him
both halves and ask him to confirm or correct the check and the image.
The `REPLACE-ME-with-...` image placeholder means no signal named one -
that is the field to ask about first.

**On no**, that's the end of it. Don't run `fabrica register`, and don't
retry the `fabrica do`.

## What this file deliberately does not cover

`fabrica cost` is owner-only — it's how the Client records a task's real
spend, not something asked of the assistant, and it's deny-listed
wherever the per-tool rulebook exists for the same reason `verdict` and
`answer` are. If a worker's spend is ever unknown and the Client wants to
clear it, tell him the command; don't run it.
