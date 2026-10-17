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

`/api/version` answers `{ "commit": "<sha-or-null>" }` - exactly the
commit `src/cli/doctor-command.ts`'s `runningCopyCommit` (the same
function behind `fabrica doctor`'s "checkout" line) computes for this
running copy. It exists so `fabrica up` can tell a live view running
today's code from one left running from before a merge (a stale one
otherwise silently serves a blank page against today's record shape) -
see that command's own README section. The one write in this directory
isn't in `server.ts` either: `start.ts` (the real process entry point,
not the server module itself) writes `<recordHome>/live-view.pid` once
it's actually bound to its port, for `fabrica up` to find and verify
before ever stopping it (`src/cli/live-view-process.ts`).

## What the task list page shows, and what's one click away

A row shows four things: a small symbol for the task's state, the age of
its last recorded activity, the state word, and a short title - the
worker's write-up title (`WorkerWriteup.title`, carried as a sibling of
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
  front of it. This card has three buttons - accept, fix (with a
  one-line note, required), wrong (with a one-line note, optional).
- **Inspector refused it, with no delivery behind the refusal** - a
  narrower card: just the title and Inspector's own report in plain
  words (never the generic "Inspector reached no verdict" placeholder
  `fabrica status` falls back to elsewhere - the actual reason matters
  here), with one button, wrong.
- **Failed before any work started** - a crash, a cap refusal, or a
  project that was never plugged in, all before a worker ever ran - the
  same narrow card, naming the exact recorded error, with one button,
  wrong.

All three are what `src/foreman/queries.ts`'s `earlyStopKindOf` (plus
`state === "delivered"`) says is waiting on the Client - the exact same
function `fabrica status` calls for its own "awaiting your verdict"
lines, so the two surfaces can never show a task the other doesn't, or a
different reason for the one they agree on
(`integrations/live-view/state-agreement.test.ts` proves this by running
every fixture through both). "Accept"/"fix" have nothing to act on for
the two narrower kinds (no delivery to accept, no warm worker or line to
reopen for a fix) - `wrong` alone closes either, a Client ruling from
before this page existed (issue #143). When nothing is waiting on the
Client at all, the page says so in words ("Nothing waiting on you.")
rather than showing an empty list.

Whichever button a tap is on, it records the verdict through the *exact
same* `recordVerdictDecision` - `spawnDetachedResume` pair `fabrica
verdict` itself calls (`src/cli/verdict-command.ts`): a bad ruling fails
the same way here as on the command line, and a "fix" hands the round to
the same detached background process, returning immediately rather than
waiting for it (issue #123).

### This is the one write anywhere in this directory

Everything else in this module only ever reads. `POST /api/review/tasks/
<id>/verdict` is the sole exception, and it's held to two checks GET
never needs:

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
- **A real decision.** The same validation `fabrica verdict` already
  does (unknown task, already closed, a "fix" with no note, an unknown
  ruling) runs before anything is recorded, by calling the identical
  function.

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
