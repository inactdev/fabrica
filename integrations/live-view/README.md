# Live view

A tiny, read-only local web app for watching what the factory is doing
(issue #26). Plain HTML, CSS, and JavaScript - no framework, no build
step, no outside network requests. The page polls the server every 2
seconds.

## Starting it

`npm run live` (reads `FABRICA_HOME`, same default as every `fabrica`
command - `~/.fabrica`). A new `fabrica live` command was considered and
rejected: every existing command is a short request/response call (or
`do`'s own detached-background one) dispatched through `src/cli/main.ts`
and individually classified as free or deciding in
`skill/claude-code/settings.json`'s Bash allow/deny list, with two layers
of tests enumerating every command by name. This is a long-lived
foreground HTTP server - a different shape of thing than anything else
`fabrica` runs - and threading it through that machinery would be a
bigger change than the viewer itself. An npm script matches how this
repo already starts its own tooling (`npm test`, `npm run typecheck`).

## What it is allowed to do

It serves on `http://127.0.0.1:7777` and binds to `127.0.0.1` only -
`server.ts`'s `HOST` constant is not a parameter anywhere, so there is no
way to ask it for anything else. It reads only `events.jsonl` and the
`tasks/<id>/` folders under the given record home, and never writes
anything: every filesystem call in `server.ts` is a `readFileSync`/
`readdirSync`, directly or through `src/index.ts`. The only thing a
request can send it is which task id it wants (its own `/tasks/<id>`
page, `/api/tasks/<id>`, or `/api/tasks/<id>/transcript`), and that is
checked against `TASK_ID_PATTERN` (the same shape `src/record/ids.ts`
generates) before it ever reaches a file path.

The one write in this directory isn't in `server.ts` either: `start.ts`
(the real process entry point, not the server module itself) writes
`<recordHome>/live-view.pid` once it's actually bound to its port, for
`fabrica up` to find and verify before ever stopping it
(`src/cli/live-view-process.ts`).

## Two commits, and why they are two endpoints

`/api/version` answers `{ "commit": "<sha-or-null>" }` with the commit
**this server process is running** - captured exactly once, in
`startLiveView`, by `src/cli/doctor-command.ts`'s `runningCopyCommit`
(the same function behind `fabrica doctor`'s "checkout" line), and never
read again for the life of the process.

`/api/checkout` answers the same shape with the commit **on disk right
now**, by calling that same reader per request.

That split is load-bearing, and it is the fix for a real bug.
`/api/version` used to call the reader per request too. For the copy
that matters - a developer checkout - the reader shells out to `git
rev-parse HEAD` against the checkout, so a live view process started
before a merge happily reported the commit the checkout had since moved
to: the code on disk, not the code it was actually executing. Both
callers of that endpoint (`fabrica up` and `fabrica update`, through
`src/cli/up-command.ts`'s `refreshStaleLiveView`) compare its answer
against *their own* read of that same on-disk value - so the comparison
was a value against itself, could never differ, and the one thing the
check exists to catch (a live view left over from before the code moved)
was the one thing it could never catch. A stale server otherwise goes on
serving a page built against yesterday's record shape, silently.

With the commit pinned at startup, the two endpoints disagreeing is a
real signal, and three things read it: `fabrica up` (replaces a stale
live view rather than reusing it), `fabrica update` (restarts it), and
every page's own banner (below).

## The banner strip - `public/banner.js`

Two things can make a page here quietly lie, and each gets a band across
the top of every page that nobody can miss:

1. **The server is running older code than the checkout** -
   `/api/version` against `/api/checkout`, by exactly the rule
   `refreshStaleLiveView` applies (stale only when both commits are
   known strings and differ; an unknown on either side says nothing
   rather than guessing). The banner names both commits and the command
   that fixes it: `fabrica update`.
2. **`projects.toml` is there but will not parse** -
   `/api/config-problem`, which carries the file's path, the line the
   parser stopped on, and what it objected to. Every cap and project on
   the page is a default standing in for a number nobody set while that
   is true, and nothing else on the page distinguishes that from a
   deliberate choice.

`banner.js` is loaded by all four pages and is deliberately
self-contained: it builds its own DOM, polls its own endpoints, and needs
no wiring in `app.js`/`task.js`/`review.js`. One script for four pages
beats three renderers that each have to stay in step. `/api/version` is
fetched **once** (a running process's startup commit cannot change while
it is answering); the other two are polled on the same 2-second tick the
pages use, so a banner appears within one poll of the checkout moving or
the file breaking. Its two sentences are hand-duplicated from
`display.ts`'s tested `stalenessNotice`/`configProblemNotice` - the same
reason `app.js` duplicates `formatAge` - and `server.test.ts` pins both
copies word for word so the one that actually runs in a browser cannot
drift.

A `projects.toml` that will not parse is never an HTTP error here: a
broken config is not a broken server. `record-view.ts` reads it through
`loadConfigOrProblem` (`src/config/`), which hands back the same empty
config a missing file does plus the problem to show - so the task list
keeps rendering from the record, which needs no config at all. It used to
rethrow that case straight out of `getState`, which turned every page
into one "could not read the record" line: a config problem reported as a
record problem, with the task list taken down with it.

## What the task list page shows, and what's one click away

A row carries twelve columns (issue #203), every one of them derived
from the task's own record and nothing else: **state**, **task**,
**project**, **worker · model**, **network policy**, **trigger**,
**started**, **duration**, **cost** (with a cap meter), **checks**,
**delivery**, and **confidence**. The task column is the worker's
write-up title (`WorkerWriteup.title`, carried as a sibling of
`delivery` on the "delivered" event's own `details` - never on the
ratified `Delivery` shape itself, which the contract doesn't promise it)
once there is one, else the task text's first line cut to about 60
characters (`record-view.ts`'s `taskTitle`). Clicking a row goes straight
to that task's own page, `/tasks/<id>` (`public/task.html`/`task.js`,
served for any path matching `TASK_ID_PATTERN`): the task text, project,
attempt, cost, pull request link, and write-up - everything
`record-view.ts`'s `TaskView` carries except the transcript - in a column
on the right, and the full live transcript as the page's own dense event
stream on the left.

Each column's own derivation lives beside it in `record-view.ts`
(`latestReceipt`/`workerLabel`, `networkPolicyLabel`, `triggerLabel`,
`checksLabel`, `deliveryFromEvents`, `capsAtStart`). Four are worth
knowing without reading the code:

- **network policy** says what the record can actually say, which today
  is "not recorded" or the `network-refused` events attributed to this
  task. The reference adapter really does pick a policy per call
  (`src/brain/adapters/claude-code.ts`'s `prepareNetwork`: a
  relay-backed isolated network when a worker token is present,
  `"allowed"` when there is none) - but nothing writes it down.
  `Brain.work`/`BrainWorkResult` are ratified contract shapes with
  nowhere to carry it, and that adapter's relay points its own refusal
  bookkeeping at a throwaway scratch record home precisely because
  `Brain.ask`/`work` take no task id at all, a gap its own header
  states. This column will show a real policy the day one is recorded,
  and until then it does not invent one.
- **trigger** is what started the round the task is on - `do`,
  `answer`, or `fix N` - plus the issue number when one was named
  explicitly (`--issue`, persisted as the task's own `issue` file).
  Every task begins as one `fabrica do`, so the round is the only part
  of "what triggered this" the record can answer differently per task.
- **duration** runs to now for an open task and freezes at whatever a
  finished one last recorded, so the history page isn't full of
  counters still ticking. The server decides which; the page only
  formats it.
- **cost** is `describeTaskCost`'s own wording - the same words
  `fabrica status` uses - against the per-task cap *the task started
  under*, not whatever `projects.toml` says when the page is read.
  That cap is written once at registration into the task's own
  `caps.json` (`src/foreman/ask.ts`); a task registered before that
  file existed falls back to the current config. With no cap set there
  is no meter at all and the cost stands as plain text (Client ruling).

## One DOM, two layouts: phone and desk

Below tablet width every row is a stacked card, each column a labeled
row; at 768px and up the same nodes become a table with its header
pinned to the top of the page. There is no second renderer and no
media query in JavaScript: each cell carries its column name in a
`data-label` attribute, which the phone layout prints in front of the
value through a CSS `::before` (`style.css`, written mobile-first - the
card layout is the base, the table is the one media query). The header
row in `index.html`/`history.html` spells the same names as those
`data-label`s on purpose, so a column can never end up named two
different things depending on how wide the window is. Both pages also
carry the `width=device-width` viewport meta - without it a phone
renders at a notional desktop width and the card layout never applies.

## Two pages, split by whether a task is still open (a third, `/review`, is below)

`/` (the default) lists only open tasks - working, asked a question,
delivered - newest activity first, with a plain "History" link in the
header. `/history` lists only finished tasks - failed, stopped, closed
(either ruling) - newest first, with a "Live" link back. The split is
enforced server-side (`server.ts`'s `/api/state` vs `/api/history`, both
reading the same `view.getState()` and keeping only the half of `tasks`
each endpoint is allowed to show), not left to the page's own JS to get
right - `server.test.ts` proves it by hitting both endpoints directly.
Both pages share one script (`public/app.js`, reading `location.pathname`
to pick its endpoint and empty-state wording) since the row format is
identical on both.

## Two things that both want the word "stopped"

`record-view.ts`'s `DisplayState` has had a `"stopped"` label since
issue #26 - for `stateOf`'s `"refused"`, Inspector reaching no verdict.
Its own comment quotes a Client ruling: keep "stopped" for a task that
was actually stopped. Nothing could actually stop a task then; issue
#203's `stop` means something can now. Rather than re-label a word that
is already ruled on and already asserted in tests, the owner's stop
renders as its own `"stopped by you"` and the collision is left for the
Client to rule on. If he wants the older label renamed (to "no verdict",
say), that is a one-line change here plus the two hand-kept browser
copies and their tests - not something to do under a ratified
assertion's feet.

## The state symbol, and why "working" has no glyph

Every state gets a small symbol before its word - a check for delivered,
a question mark for asked a question, a red X for failed, a gray dot for
stopped and for either closed ruling - plain text/inline shapes, no icon
font, no outside file. "working" is the one exception: its indicator is a
small CSS-drawn ring with an animated spin (`style.css`'s `symbol-spin`,
the page's one allowed animation), not a text character, since nothing in
this monospace-only palette reads as motion. Failed and asked-a-question
rows get a brighter background and bolder title (`row-emphasis`); a
closed row (either ruling) fades back (`row-fade`, lower opacity) - the
mapping from state to symbol/emphasis is `display.ts`'s `stateSymbol`/
`rowEmphasis`, unit tested there since a plain script with no build step
can't import it - `app.js`/`task.js` each keep a hand-duplicated copy, the
same pattern `app.js`'s own `formatAge` comment already explains.

## Why a steady poll no longer jumps the page

Both list pages and the task page used to rebuild every row on every
2-second poll, even when nothing had changed - worst on a finished task's
page with a long transcript, where the view would reset every poll. Now a
row's DOM node is created once per task (or per transcript entry) and
kept for as long as that task/entry is shown; each poll only writes the
specific text or class that actually differs from what's already on
screen (guarded by a plain `!==` check), and never touches a row whose
displayed fields haven't changed at all. The transcript additionally
relies on the record being append-only: a poll only ever appends the
entries past what was already rendered, never re-walks the ones already
on screen. With "Tail: on", a poll only scrolls to the bottom if the view
was already there when the poll started (`display.ts`'s
`isScrolledToBottom`, duplicated in `task.js` against the one window-level
scroll position this page reads) - scrolling up to read is no longer
undone by the next poll. Turning tail on with the toggle button is the
one deliberate exception: that always jumps to the bottom immediately,
regardless of where the view currently is.

## The phone review page: `/review`

A third page (issue #202), deliberately narrow (phone-width, large touch
targets) rather than matching the two desktop list pages above. It shows
every task actually waiting on the Client, which is not only "delivered"
any more (follow-up to issue #202, "show every task waiting on me"):

- **Delivered** - the full card: its title, the pull request's own
  write-up (rendered through the exact same `finalMessageFor` that built
  the real pull request body, never a second hand-written copy of it),
  Inspector's stamp, and the gate's declared state
  (`record-view.ts`'s `getReviewRows`/`inspectorStampLabel`/
  `gateStateLabel` - see their own doc comments for exactly what each
  label means and where it comes from). "Inspector's stamp" and "the
  gate's state" here are both read from Fabrica's own record - the real
  `Delivery.inspection`/`Delivery.gateChanges` Fabrica already has, never
  a live call out to GitHub's API: that would mean this read-only viewer
  needing its own GitHub credential and network egress for a page whose
  whole point is reviewing a handful of deliveries already sitting in
  front of it. This card has one note box and three buttons - accept,
  fix, wrong (see "One note box per card" below).
- **Inspector refused it, with no delivery behind the refusal** - a
  narrower card: just the title and Inspector's own report in plain
  words (never the generic "Inspector reached no verdict" placeholder
  `fabrica status` falls back to elsewhere - the actual reason matters
  here), with the same note box and one button, wrong.
- **Failed before any work started** - a crash, a cap refusal, or a
  project that was never plugged in, all before a worker ever ran - the
  same narrow card, naming the exact recorded error, with the same note
  box and one button, wrong.
- **Asked a clarifying question** - a task that stopped on SPEC.md step
  2 and is waiting on the Client's own words rather than on a ruling.
  Its card has no write-up, no stamp and no verdict buttons at all: the
  worker's questions, numbered the way `fabrica answer` numbers them in
  `answers.md`, one box to answer all of them at once (which is what
  `fabrica answer <id> -m "<text>"` takes too - one answer per round,
  not one per question), and one button, send. This is what lets a
  phone - and, later, Amy - unblock a worker without a terminal.

Above the list, in the toolbar, sit the two **subscription meters**
(issue #189): how much of the model provider's 5-hour and 7-day windows
the account has used, and what the pause rule makes of them right now
("PAUSED" with the reason when the week is past its refuse threshold; a
plain statement that no usable reading exists when there is none). They
are here because this is the page where the Client decides whether to
spend a round, and a flat-rate subscription's own windows are the one
budget no dollar figure on any page can show - filling the week costs
nothing. `record-view.ts`'s `getMeters` reads them through the same
`standingOf`/`refusalFor`/`pauseRuleFor` functions the pause rule
itself decides with (`src/foreman/meters.ts`), so this page and
`fabrica status` can never show different numbers. A task a meter
stopped mid-round shows up as an ordinary delivered card: it is waiting
on the Client's own `fix` verdict, which is exactly what a delivery
means here, and never reads as a failure.

Below that list sits a second, separate one (issue #203): **Running** -
the tasks currently working, each with what it is, where, how long it
has been going, what it has spent, and the worker's own last transcript
line, and one button: **stop**, behind one confirmation. A running task
is the opposite of one waiting on the Client, so it is deliberately not
folded into the rows above: `getReviewRows` stays exactly the set
`fabrica status` flags as waiting (an agreement `state-agreement.test.ts`
pins task by task), and `getRunningRows` is its own list on its own
`running` array in `/api/review`'s response. A task with nothing to
stop simply has no section.

The first three are what `src/foreman/queries.ts`'s `earlyStopKindOf`
(plus `state === "delivered"`) says is waiting on the Client - the exact
same function `fabrica status` calls for its own "awaiting your verdict"
lines, so the two surfaces can never show a task the other doesn't, or a
different reason for the one they agree on
(`integrations/live-view/state-agreement.test.ts` proves this by running
every fixture through both). "Accept"/"fix" have nothing to act on for
the two narrower kinds (no delivery to accept, no warm worker or line to
reopen for a fix) - `wrong` alone closes either, a Client ruling from
before this page existed (issue #143). The fourth, the asking card, is
the one row that isn't a verdict at all, so the surface it agrees with
is `fabrica await`'s own "answer with fabrica answer `<id>`" notice (and
the recorded questions themselves), not a status line that state has
never carried. When nothing is waiting on the Client at all, the page
says so in words ("Nothing waiting on you.") rather than showing an
empty list.

### One note box per card

Every card that offers a verdict carries exactly one note box, visible
up front rather than revealed by a tap, and every verdict button on that
card reads it (Client ruling): **optional** for `accept` and `wrong`,
**required** for `fix`. One tap still records a verdict - whatever
happens to be typed rides along as the note, and an empty box sends the
`note` key off the request entirely, landing on the record exactly as
`fabrica verdict <id> accept` with no `-m` does (an empty note is never
recorded as the Client's reaction to something). `display.ts`'s
`noteToSend` is that one rule, unit tested there and hand-duplicated in
`review.js` like every other function in that file. The note itself is
the Client's own labeled reaction and goes to the same two places a
`-m` note always has: the task's `verdict` file and the
`verdict-recorded` event (`src/foreman/verdict.ts`).

It is deliberately one box per card rather than one per button: a second
input would mean text typed in the visible box could be silently dropped
by whichever button was tapped, on the only page in this directory that
records decisions. This also replaces the browser `prompt()` dialogs
`fix` and `wrong` used to collect a note through - nothing on this page
opens one now. Typed text survives the 2-second poll for the same reason
a half-made decision always has: a card's DOM node is built once and
left alone while it is on screen (`renderRows`).

All three buttons stay behind one confirmation, as they each effectively
were before (the dialog `fix` had to pass through was its own): a verdict
closes a task or spends real money on a fresh round, and a phone is where
a mis-tap is likeliest.

Whichever button a tap is on, it records the Client's decision through
the *exact same* pair of functions the command line calls:
`recordVerdictDecision` - `spawnDetachedResume` for a verdict
(`src/cli/verdict-command.ts`), `recordAnswerDecision` -
`spawnDetachedResume({ kind: "answer" })` for an answer
(`src/cli/answer-command.ts`). A bad ruling or a bad answer fails the
same way here as on the command line, with the identical message, and a
"fix" or a resumed round hands the work to the same detached background
process, returning immediately rather than waiting for it (issue #123).

### These are the only writes anywhere in this directory

Everything else in this module only ever reads. `POST /api/review/tasks/
<id>/verdict`, `POST /api/review/tasks/<id>/answer` and `POST
/api/review/tasks/<id>/stop` are the exceptions, and all three are held
to the same two checks GET never needs:

- **Identity.** A request carrying no `Tailscale-User-Login` header is
  refused (403) before its body is even read. This server still only
  ever binds to `127.0.0.1` (`HOST`, in `server.ts` - unchanged by this
  page); the one legitimate way a real header lands here at all is a
  locally-running `tailscale serve` adding it while proxying a request
  in from the tailnet. That's Tailscale's own documented design, not
  something invented here: Serve's reverse-proxy target only ever
  supports `http://127.0.0.1` (its own docs, verified before writing any
  of this), it adds `Tailscale-User-Login`/`-User-Name`/
  `-User-Profile-Pic` to a proxied request and *strips* those same
  headers from anything a client tried to send itself ("to avoid header
  spoofing" - its own words), and its own best-practice note is to keep
  the backend on loopback precisely so nothing but Serve can ever
  produce a trustworthy header. Binding this server anywhere else (the
  tailnet address directly, say) would both break Serve's proxy contract
  and make the header meaningless - anyone who could reach the port
  directly could forge it.
- **A real decision.** The same validation `fabrica verdict`/`fabrica
  answer` already do (unknown task, already closed, a "fix" with no
  note, an unknown ruling; no question pending, a clarification round
  already spent, an empty answer, a cap refusal) runs before anything is
  recorded, by calling the identical function. An answer is held to the
  identity check for the same reason a verdict is: it becomes part of
  the brief a worker is handed and spends real money resuming the task,
  so it is every bit as much a decision as a ruling. The one thing
  checked here rather than there is the request's own shape - a body
  without a string `answer` is a 400 - because `recordAnswerDecision`
  takes words, not JSON.

### Stop (issue #203)

The third write, and the only one in this directory that reaches
outside the record at all. It is held to the same identity gate as the
other two, with the same 403 and the same one-line message - a stop
ends work that is costing money and throws away whatever the worker was
part-way through, so it is at least as much a decision as a ruling.
Unlike the other two it also *records who made it*: the
`Tailscale-User-Login` goes into the event, because those two write a
ruling or an answer the Client composed, while this one writes only "it
was stopped," and by whom is the rest of that sentence. It reads no
body at all; the one confirmation happens on the page before the
request is ever sent (Client ruling: "one confirmation tap").

What it does, in order:

1. `recordStopDecision` (`src/foreman/stop.ts`) refuses a task that is
   not running - a 400 naming the state it is actually in. The page
   only ever offers the control for a running task, but a page can be a
   couple of seconds stale, and refusing is a better answer than
   stopping something that finished an hour ago (both halves are the
   Client's own ruling).
2. It appends `stopped-by-owner`, carrying who stopped it, which state
   it was stopped from, and the worker's last transcript line with its
   timestamp. **The task is terminal from that moment** - `stateOf`
   treats the state as absorbing, so anything the dying process still
   manages to append (a last heartbeat, a finished check, even a
   delivery from work it had already done) is kept on the record but
   never makes the task look alive again. His own `accept`/`wrong`
   verdict is the one thing that can still move it. That ordering is
   the ruling itself: the Client's decision is the fact, and the signal
   is how the machine is asked to catch up with it.
3. Only then does it signal: SIGTERM to the task's own detached
   process, SIGKILL ten seconds later if it is still there
   (`src/cli/task-process.ts`, which will not signal a pid it has not
   re-verified against the live process table first - see that file and
   `src/cli/README.md`). A task whose process cannot be identified is
   still stopped; the response says `signaled: false` and the page says
   so rather than pretending either way.

The control is also **absent** from the page when the request carrying
it isn't identified (Client ruling: absent without identity, *and*
refused by the server without it). A browser script cannot read the
headers its own page was fetched with, so `/api/review` - which arrives
through the very same Serve proxy that adds the header to a POST -
answers an `identified` boolean alongside its rows, and `review.js`
draws one dim line instead of the button when it is false. That is a
display hint only: the route makes its own decision on its own request,
and a page that drew the button anyway would get the same 403.

**What's deliberately NOT here (the "dotfiles half" of issue #202):**
actually running `tailscale serve` to publish this port onto the
tailnet is a one-time, host-level command outside this repository - the
same way nothing in this repo runs `tailscaled` itself or configures
Tailscale ACLs. This page is reachable from a phone once that's set up;
nothing in this directory sets it up.

## Why a corrupt line in events.jsonl can't take it down

`record-view.ts` builds its whole picture of the record through
`followTask` (already exported from `src/index.ts` for `fabrica watch`),
never through `readEvents`/`eventsByTask`. `followTask`'s line reader
already skips a line that fails `JSON.parse` instead of throwing
(`src/foreman/follow.ts`'s `parseLine`) - the same mechanism `fabrica
watch` relies on to survive a short write. `readEvents` is deliberately
left throwing on a bad line for everyone else (`fabrica log`/`status`'s
one-shot reads, rule 10's cap checks): changing that global behavior to
make this viewer's job easier would have a much bigger blast radius than
this read-only tool needs. Task ids themselves come from listing
`recordHome/tasks/` (the record's documented, stable layout), not from
events.jsonl at all.

## What's new on `src/index.ts`

`daySpend`, `readTaskFile`, `TASK_ID_PATTERN`, and `WorkerWriteup` were
not previously exported from Fabrica's one public entry point - this
integration adds them there rather than reaching into
`src/foreman/`/`src/record/`/`contract/` directly, the same rule
`src/cli/` already follows. Issue #202's review page added two more:
`deliveryOf` (the real `Delivery`, for Inspector's stamp and the gate's
declared state) and `finalMessageFor` (the pull request's own write-up
text, rendered once and reused rather than reimplemented). Recording a verdict itself needs two more things only `src/cli/` had
before: `loadConfigOrDefault` (the record's caps) and
`spawnDetachedResume` (handing a "fix" round to the same detached
background process `fabrica verdict fix` uses) - reached the same way
`/api/version`'s `runningCopyCommit` already was, imported directly
from `src/cli/` rather than through `src/index.ts`, the one established
exception to the "integrations reach Fabrica only through `src/index.ts`"
rule.

Issue #203's stop route added `recordStopDecision` (the record half, on
`src/index.ts` like the rest) plus `Receipt` and `GateResult` as types,
which the worker/model and checks columns read; its process half,
`findTaskProcess`/`stopTaskProcess`, is imported straight from
`src/cli/task-process.ts` under the same established exception
`runningCopyCommit` and `spawnDetachedResume` already use.

Issue #189's meters line added `describeMeters`, `latestMeterReading`,
`pauseRuleFor`, `refusalFor` and `standingOf` (plus the `MeterStanding`
type) to `src/index.ts` - the pause rule's own decision functions, so
this page shows the same numbers that gate new work rather than a second
reading of the same receipts.

The staleness banner and the loud `projects.toml` added one export,
`loadConfigOrProblem` - the reader that hands back usable defaults *plus*
the problem, for a surface that must keep working against a broken config
rather than refuse. `loadConfig` and `src/cli/load-config.ts`'s
`loadConfigOrDefault` still throw on the same file, deliberately:
`fabrica do`/`answer`/`verdict` spend real money and must refuse rather
than quietly run with no cap. Readers degrade loudly, spenders refuse.
`pauseRuleFor` is no longer read here - the pause rule comes off the same
`loadConfigOrProblem` call, which is one fewer read of the same file and,
unlike `pauseRuleFor`, does not throw on a file that will not parse.

The answer route added nothing to that list: `recordAnswerDecision` has
been on `src/index.ts` since issue #123 split the CLI's answer command
into "record now, run detached," and `spawnDetachedResume` - already
imported here for a "fix" - takes `kind: "answer"` for this round. The
questions it shows come off the task's own `"questions-asked"` event,
read through the same follower cache every other row already uses, so
there is no new reader either.
