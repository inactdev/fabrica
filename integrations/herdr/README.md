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

1. Opens a Herdr pane (`pane split`).
2. Runs `fabrica watch <id>` in it (`pane run`), carrying this watcher's
   own `FABRICA_HOME` along so the pane watches the same record
   regardless of Herdr's own environment.
3. Names that pane's row after the task - the first line of its
   `request.md`, capped at 60 characters (`pane name`).

From then on it keeps that pane's reported agent state in step with the
task (`pane report_agent`):

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

```
HERDR_BIN="herdr" npx tsx integrations/herdr/herdr-watcher.ts
```

Environment:

- `FABRICA_HOME` - the record home to follow (default `~/.fabrica`, same
  as every other Fabrica command).
- `HERDR_BIN` - the command to run for every Herdr call, space-separated
  (default `herdr`). Point this at something else - e.g. `node
  /path/to/a/wrapper.mjs` - to run against anything other than a `herdr`
  binary on `PATH`.

## The assumed Herdr CLI shape

Herdr (`herdr@0.0.0` on npm) is a reserved package name with no shipped
API yet. This integration assumes the smallest CLI shape its own
vocabulary implies - `<bin> pane split`, `<bin> pane run <paneId>
<command>`, `<bin> pane name <paneId> <name>`, `<bin> pane report_agent
<paneId> <working|blocked|done>` - each wrapped in its own one-line
function in `herdr-watcher.ts` (`splitPane`, `runInPane`, `namePane`,
`reportAgent`). If the real CLI's shape differs once it ships, only
those four wrappers should need to change - nothing else here depends on
the shape of a Herdr call, only on when one happens.

## Testing

`helpers/fake-herdr.mjs` stands in for the real binary: it does nothing
real, just records every invocation it receives as one JSON line in the
file named by `FAKE_HERDR_LOG`, and prints a deterministic, incrementing
pane id for `pane split` calls (counted from that same log). Point
`herdrBin` at `[process.execPath, ".../helpers/fake-herdr.mjs"]` to run
against it, the same way the tests do.

Run just this integration's tests (they are not part of `npm test`'s
`contract/` + `src/` discovery - see the top-level `CLAUDE.md`):

```
npx tsx --test integrations/herdr/*.test.ts
```

`tsc --noEmit` (via `npm run typecheck`, part of `npm test`) does cover
this directory - `tsconfig.json`'s `include` lists `integrations/**/*.ts`
alongside `contract/`, `src/`, and `skill/`.
