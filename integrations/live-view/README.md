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
anything: every filesystem call in this directory is a `readFileSync`/
`readdirSync`, directly or through `src/index.ts`. The only thing a
request can send it is which task id it wants (its own `/tasks/<id>`
page, `/api/tasks/<id>`, or `/api/tasks/<id>/transcript`), and that is
checked against `TASK_ID_PATTERN` (the same shape `src/record/ids.ts`
generates) before it ever reaches a file path.

## What the task list page shows, and what's one click away

A row on `/` shows three things: the age of the task's last recorded
activity, the state word, and a short title - the worker's write-up title
(`WorkerWriteup.title`, carried as a sibling of `delivery` on the
"delivered" event's own `details` - never on the ratified `Delivery`
shape itself, which the contract doesn't promise it) once there is one,
else the task text's first line cut to about 60 characters
(`record-view.ts`'s `taskTitle`). Clicking a row goes straight to that
task's own page, `/tasks/<id>` (`public/task.html`/`task.js`, served for
any path matching `TASK_ID_PATTERN`): the task text, project, attempt,
cost, pull request link, and write-up - everything `record-view.ts`'s
`TaskView` carries except the transcript - in a column on the right, and
the full live transcript as the page's own dense event stream on the
left.

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
`src/cli/` already follows.
