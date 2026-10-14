# Herdr integration

A small, optional watcher that mirrors Fabrica's record into
[Herdr](https://herdr.dev), a terminal workspace manager for AI coding
agents. It lives here, outside Fabrica's core (`src/`), because Fabrica
itself never needs to know Herdr exists - see `no-herdr-in-core.test.ts`,
which proves nothing under `src/` mentions it.

## What it does

`herdr-watcher.ts` follows `events.jsonl` (the same byte-offset tail
reader `fabrica watch` reads through - `createLineTail`, re-exported from
`src/index.ts`) and reacts to it using exactly six Herdr commands - the
ones the Client has verified by hand on his real Herdr, plus `pane
send-keys`/`tab close` for closing a task's tab (https://herdr.dev/llms-full.txt).
Nothing else: no `pane split`, no `agent rename`, no `pane
report-metadata`.

For every **new** `task-received` event:

1. `herdr tab create --no-focus --label "<title>"` - opens a new tab.
   The pane id and tab id are taken from the JSON response's
   `result.root_pane.pane_id` and `result.tab.tab_id` fields, never from
   raw stdout otherwise - both are kept for the task's whole lifetime,
   the pane id for every report/release/send-keys call and the tab id
   for the eventual close:

   ```json
   {"id":"cli:tab:create","result":{"root_pane":{"pane_id":"w2:p6", ...},"tab":{"tab_id":"w2:t5","label":"...", ...}}}
   ```

2. `herdr pane run <pane_id> "fabrica watch <taskId>"` - one argv
   element, not a shell string (this watcher never invokes a shell), so
   the command reaches Herdr exactly as given. It carries this
   watcher's own `FABRICA_HOME` along, so the pane watches the same
   record regardless of Herdr's own environment:
   `FABRICA_HOME=<recordHome> fabrica watch <taskId>`.
3. `herdr pane report-agent <pane_id> --source custom:fabrica --agent
   "<title>" --state working --seq 1` - registers the row. The `--agent`
   value is the task's own title, computed once and reused for every
   later call for this task - there is no separate `agent rename` call
   to name it.

`<title>` is the task text's first line, cut to 60 characters.

From then on, every record event keeps that row truthful:

| Record event | Reported state | `--message` |
| --- | --- | --- |
| `heartbeat` | `working` | (none) |
| `delivered` | `idle` | `delivered - awaiting your verdict` |
| `questions-asked` | `blocked` | `asked a question` |
| `task-failed` | `blocked` | `failed - see fabrica log` |

Each of those is one more `herdr pane report-agent` call, same shape as
above. `working`, `idle`, and `blocked` are the only states this
watcher ever sends.

A `verdict-recorded` event with ruling `accept` or `wrong` (rule 6: the
two rulings that actually close the task) instead runs three commands,
in order, and stops tracking the task:

1. `herdr pane release-agent <pane_id> --source custom:fabrica --agent
   "<title>" --seq N` - Herdr's own docs describe `release-agent` as
   clearing the row's name, state, and resume command, to be called
   "only when the user actually quits," which a closed task is.
2. `herdr pane send-keys <pane_id> ctrl+c` - stops the `fabrica watch`
   process running in that pane cleanly, before the tab it's running in
   disappears out from under it.
3. `herdr tab close <tab_id>` - closes the tab itself. Herdr's docs note
   CLI/API closes are immediate, no confirmation prompt.

A `fix` verdict does none of this: it reopens the loop rather than
closing it, and the next heartbeat the resumed worker emits already
reports `working` again, so there's no separate case for it here - the
tab stays open exactly as before.

`--seq` is a per-task counter, starting at 1 on the task's first
`report-agent` call and increasing by one on every `report-agent` or
`release-agent` call for that task after that - matching Herdr's own
"`--seq` must increase with every report from your source" rule.

It is a pure follower: it never spawns, signals, or otherwise touches a
task's own process, the same guarantee `fabrica watch` itself makes.
Stopping this script only stops the mirroring - the task, and the
`fabrica watch` processes already running inside their panes, keep going
untouched.

On startup it drains whatever is already on the record before reacting
to anything, so a restart never reopens a tab for a task that was
received - and possibly long since closed - before this process started.
It only ever opens tabs for tasks received while it's running.

## A failing Herdr call never stops the watcher

Every one of the six commands above is wrapped: if it fails (Herdr's
own CLI exits 1 with a JSON error on timeout or a server error, or 2 on
invalid syntax - https://herdr.dev/llms-full.txt), the exact arguments
and whatever Herdr printed are appended as one line to this record
home's own `herdr-watcher.log`, and the watcher moves on to the next
event or the next poll - it never exits because one command failed. A
failed `tab create` means that task is skipped entirely (there's no
pane id to do anything else with); a failed `pane run`,
`report-agent`/`release-agent`, `send-keys`, or `tab close` call is
logged but doesn't stop the other calls around it (a failed close still
leaves the task untracked - there's nothing more to retry it with) or
any later poll.

## Starting it

Run this *inside a Herdr pane* - Herdr injects `$HERDR_ENV=1` and
`$HERDR_PANE_ID` (along with `$HERDR_WORKSPACE_ID`, `$HERDR_TAB_ID`,
`$HERDR_SOCKET_PATH`) into every process it starts, and the `herdr` CLI
itself needs that environment to reach the right running Herdr:

```
npx tsx integrations/herdr/herdr-watcher.ts
```

### `fabrica up` starts it for you

`fabrica up` starts this watcher automatically, detached the same way it
starts the live view, the moment it detects `$HERDR_ENV=1` and
`$HERDR_PANE_ID` in its own environment - i.e. the moment it's itself
running inside a Herdr pane - and skips it when either is missing,
saying nothing about Herdr either way. It never starts a second one for
the same record home: `herdr-watcher.ts`'s `main()` writes its own pid
to `<recordHome>/herdr-watcher.pid` on startup, and `herdrWatcherStatus`
checks that file's pid for real liveness (a signal-0 `kill`, not just
"the file exists") before `fabrica up` decides whether to start another.

If that status comes back `"exited"` - a watcher really was running for
this record home and is gone now, not just never started -
`fabrica up` says so (via the generic `notify` callback every
`up-hook.ts` gets, printed to stderr) before starting a fresh one,
rather than silently restarting as if nothing had happened. An ordinary
first start (`"never-started"`) stays silent, same as before.

This is wired through `up-hook.ts`, which `src/cli/up-command.ts`
discovers generically by scanning `integrations/` for a `<name>/
up-hook.ts` exporting `maybeStart({ recordHome, env, notify })` - the
same shape, and the same reason (CONTRACT rule 8's brain-word scan - see
`no-herdr-in-core.test.ts`), that `skill/<harness>/launch.ts` is
discovered by scanning `skill/` instead. Its own tests
(`up-hook.test.ts`) use injected fakes for the status check and the
spawn itself; `herdr-watcher.test.ts` covers the real pid-file liveness
check separately.

Environment:

- `FABRICA_HOME` - the record home to follow (default `~/.fabrica`, same
  as every other Fabrica command).
- `HERDR_BIN` - the command to run for every Herdr call, space-separated
  (default `herdr`). Point this at something else - e.g. `node
  /path/to/a/wrapper.mjs` - to run against anything other than a `herdr`
  binary on `PATH`.

## What to expect on screen

Within a second of a `fabrica do` (or `fabrica answer`) call registering
a new task, a new tab opens running `fabrica watch <id>` - so its
content is exactly what you'd see running that command yourself - named
after the task's own first line. The row's agent-state badge reads
**working** while the task is actively being worked (heartbeats arriving
every ~15s), flips to **idle** the moment there's a delivery sitting
there for your verdict, or **blocked** on a clarifying question or a
failure, and is released entirely once you give a verdict that actually
closes it (`accept` or `wrong`; a `fix` verdict instead flips it back to
**working** as soon as the next heartbeat lands). On that same closing
verdict, the pane's `fabrica watch` process is sent `ctrl+c` and the tab
itself closes right after - the one case where this watcher touches the
pane/tab beyond reporting state; a `fix` verdict leaves it untouched.

## The documented Herdr CLI this relies on

Taken from Herdr's own docs (https://herdr.dev/llms-full.txt), not
guessed:

- `herdr tab create --no-focus --label TEXT` - opens a new tab, response
  shape `{"result":{"root_pane":{"pane_id":...},"tab":{"tab_id":...}}}`.
- `herdr pane run <pane_id> <command>` - one argv element.
- `herdr pane report-agent <pane_id> --source ID --agent LABEL --state
  idle|working|blocked|unknown [--message TEXT] [--seq N]` - this
  watcher only ever sends `idle`, `working`, or `blocked`.
- `herdr pane release-agent <pane_id> --source ID --agent LABEL [--seq
  N]`.
- `herdr pane send-keys <pane_id> <key> [key ...]` - this watcher only
  ever sends a single `ctrl+c`.
- `herdr tab close <tab_id>` - CLI/API closes are documented as
  immediate, no confirmation prompt.

Each is wrapped in exactly one function in `herdr-watcher.ts`
(`createTab`, `runInPane`, `reportAgent`, `releaseAgent`, `sendCtrlC`,
`closeTab`) - if Herdr's CLI shape ever changes, only those six
functions should need to change; nothing else here depends on the shape
of a Herdr call, only on when one happens.

## Testing

`helpers/fake-herdr.mjs` stands in for the real binary: it does nothing
real, just records every invocation it receives as one JSON line in the
file named by `FAKE_HERDR_LOG`, answers `tab create` with the documented
JSON shape (a deterministic, incrementing pane/tab id pair counted from
that same log) and a small ack for the other commands, and can
simulate a failing call via `FAKE_HERDR_FAIL_SUBCOMMAND` (e.g. `"pane
report-agent"`) plus `FAKE_HERDR_FAIL_TIMES` (default 1) - the first N
calls matching that subcommand exit 1 with a JSON error on stderr, the
way Herdr's own docs describe a server error. Point `herdrBin` at
`[process.execPath, ".../helpers/fake-herdr.mjs"]` to run against it, the
same way the tests do - there's no real Herdr pane in a test run.

Run just this integration's tests (included in `npm test`'s discovery
alongside `contract/` and `src/` - see `package.json`'s `test` script):

```
npx tsx --test integrations/herdr/*.test.ts
```

`tsc --noEmit` (via `npm run typecheck`, part of `npm test`) also covers
this directory - `tsconfig.json`'s `include` lists `integrations/**/*.ts`
alongside `contract/`, `src/`, and `skill/`.
