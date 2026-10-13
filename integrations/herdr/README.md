# Herdr integration

A small, optional watcher that mirrors Fabrica's record into
[Herdr](https://herdr.dev), a terminal workspace manager for AI coding
agents. It lives here, outside Fabrica's core (`src/`), because Fabrica
itself never needs to know Herdr exists - see `no-herdr-in-core.test.ts`,
which proves nothing under `src/` mentions it.

## What it does

`herdr-watcher.ts` follows `events.jsonl` (the same byte-offset tail
reader `fabrica watch` reads through - `createLineTail`, re-exported from
`src/index.ts`) and, for every **new** `task-received` event:

1. Splits its own pane to the right (`herdr pane split <pane-id>
   --direction right`), getting back the id of a new pane.
2. Runs `fabrica watch <id>` in that new pane (`pane run`), carrying this
   watcher's own `FABRICA_HOME` along so the pane watches the same
   record regardless of Herdr's own environment.
3. Names that pane's row after the task (`agent rename`) - the first
   line of its `request.md`, capped at 60 characters.
4. Gives it a matching one-line summary (`pane report-metadata --token
   summary=<title>`), shown in the Agent sidebar via Herdr's `$summary`
   token.

From then on it keeps that pane's reported agent state in step with the
task (`pane report-agent --source custom:fabrica --agent
fabrica-<id> --state ...`):

| Record event | Reported state |
| --- | --- |
| `heartbeat` | `working` |
| `questions-asked` | `blocked` |
| `delivered` | `blocked` (awaiting the Client's verdict) |
| `verdict-recorded` with ruling `accept` or `wrong` | `done` |

A `fix` verdict reopens the loop rather than closing it (rule 6); the
next heartbeat the resumed worker emits already reports `working` again,
so there's no separate case for it here.

It is a pure follower: it never spawns, signals, or otherwise touches a
task's own process, the same guarantee `fabrica watch` itself makes.
Stopping this script only stops the mirroring - the task, and the
`fabrica watch` processes already running inside their panes, keep going
untouched.

On startup it drains whatever is already on the record before reacting
to anything, so a restart never reopens a pane for a task that was
received - and possibly long since closed - before this process started.
It only ever opens panes for tasks received while it's running.

## Starting it

Run this *inside a Herdr pane* - splitting a new pane for each task
means splitting an existing one, and Herdr injects the id of the pane a
process is running in as `$HERDR_PANE_ID` (along with `$HERDR_ENV=1`,
`$HERDR_WORKSPACE_ID`, `$HERDR_TAB_ID`, `$HERDR_SOCKET_PATH`) into every
process it starts:

```
npx tsx integrations/herdr/herdr-watcher.ts
```

Environment:

- `FABRICA_HOME` - the record home to follow (default `~/.fabrica`, same
  as every other Fabrica command).
- `HERDR_PANE_ID` - set automatically by Herdr; the pane every task's
  pane is split from. Passing `basePaneId` directly to
  `createHerdrWatcher` overrides it (used by the tests, which have no
  real Herdr pane around them at all). With neither set, the watcher
  refuses to start rather than silently doing nothing.
- `HERDR_BIN` - the command to run for every Herdr call, space-separated
  (default `herdr`). Point this at something else - e.g. `node
  /path/to/a/wrapper.mjs` - to run against anything other than a `herdr`
  binary on `PATH`.

## What to expect on screen

Within a second of a `fabrica do` (or `fabrica answer`) call registering
a new task, a new pane opens to the right of the one running this
watcher. It's named after the task's own first line, running `fabrica
watch <id>` - so its content is exactly what you'd see running that
command yourself - and its sidebar row shows that same line as a
one-line summary. The row's agent-state badge reads **working** while
the task is actively being worked (heartbeats arriving every ~15s),
flips to **blocked** the moment it needs you - a clarifying question, or
a delivery sitting there for your verdict - and reads **done** once you
give a verdict that actually closes it (`accept` or `wrong`; a `fix`
verdict instead flips it back to **working** as soon as the next
heartbeat lands). The pane itself is never closed or touched again by
this watcher - only its reported state changes.

## The documented Herdr CLI this relies on

Taken from Herdr's own docs (https://herdr.dev/docs/socket-api,
/docs/agents), not guessed:

- `herdr pane split <pane-id> --direction right` - splits an existing
  pane (ids look like `w1:p1`, workspace:pane) and returns the new one.
- `herdr pane run <pane-id> "<command>"`
- `herdr agent rename <pane-id> <name>`
- `herdr pane report-agent <pane-id> --source <ns:name> --agent
  <agent-id> --state working|blocked|idle|done`
- `herdr pane report-metadata <pane-id> --source <ns:name> --token
  key=value`

Each is wrapped in exactly one function in `herdr-watcher.ts`
(`splitPane`, `runInPane`, `renameAgent`, `reportAgent`,
`reportSummary`) - if Herdr's CLI shape ever changes, only those five
functions should need to change; nothing else here depends on the shape
of a Herdr call, only on when one happens.

## Testing

`helpers/fake-herdr.mjs` stands in for the real binary: it does nothing
real, just records every invocation it receives as one JSON line in the
file named by `FAKE_HERDR_LOG`, and prints a deterministic, incrementing
pane id (`w1:p1`, `w1:p2`, ...) for `pane split` calls, counted from that
same log. Point `herdrBin` at `[process.execPath,
".../helpers/fake-herdr.mjs"]` and pass an explicit `basePaneId` to run
against it, the same way the tests do - there's no real Herdr pane in a
test run to supply `$HERDR_PANE_ID`.

Run just this integration's tests (they are not part of `npm test`'s
`contract/` + `src/` discovery - see the top-level `CLAUDE.md`):

```
npx tsx --test integrations/herdr/*.test.ts
```

`tsc --noEmit` (via `npm run typecheck`, part of `npm test`) does cover
this directory - `tsconfig.json`'s `include` lists `integrations/**/*.ts`
alongside `contract/`, `src/`, and `skill/`.
