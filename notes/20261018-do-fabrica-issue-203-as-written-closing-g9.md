# Issue #203: the phone-width live view, and `stop`

## The plan, written before changing anything

Two halves, and they share almost nothing but the record.

**Half 1 — the live view at phone width, full column set.** The two
list pages (`/` and `/history`) gain the twelve columns the issue names:
state, task, project, worker and model, network policy, trigger,
started, duration, cost with a cap meter, checks, delivery, confidence.
Per the clarification, one DOM carries both layouts: a stacked card per
task below tablet width with each column as a labeled row, the same data
as a table with a pinned header above it. `data-label` + a CSS
`::before` is what makes that one DOM — not two renderers to keep in
step, and not a JS media-query branch that re-renders on resize.

**Half 2 — `stop` on `/review`.** A `POST
/api/review/tasks/<id>/stop`, behind the same `Tailscale-User-Login`
gate as the verdict and answer routes, which records a
`stopped-by-owner` event (carrying the worker's last transcript line and
who stopped it) and then signals the task's detached process: SIGTERM,
SIGKILL after a 10-second grace. The record moves to a terminal
`"stopped"` state the moment the event lands — the Client's decision is
the fact, so the event is recorded first and the signal is best-effort
after it.

`/review` shows only tasks waiting on the Client, and a running task is
not one of those, so there was nowhere for a stop control to live. The
page therefore gains a second, separate list — running tasks — served as
its own `running` array beside the existing `rows`, so the
waiting-on-you set `state-agreement.test.ts` pins stays exactly as it
was.

## Is it the best solution, all things considered?

Safest first. The dangerous part is signaling a pid, and this project
has already paid for that lesson once: `src/cli/live-view-process.ts`
will not signal a pid it hasn't re-verified against the real process
table, because a stale pid file's number can be reused by an unrelated
process. `stop` reuses that exact discipline — its own pid file
(`worker.pid`, written by the task's detached process itself, which is
the only party that knows its own pid), liveness, and a `ps` command
line that must still contain one of the three task entry scripts before
anything is sent.

Accuracy next: every column is derived from the record and nothing is
invented. The one column the record genuinely cannot answer today is
network policy — see below.

## The alternative rejected

**Killing whatever process is attached to the task by searching `ps`
for the task id, with no pid file.** Tempting, because it needs no new
write anywhere: the answer and fix entry scripts both carry the task id
in their own argv. It was rejected because `fabrica do`'s runner does
not — its argv is `<recordHome> <projectPath> <taskText>`, and the task
id is minted inside the child, after the spawn. Matching on task text
instead would mean matching a Client-supplied string against a process
table, which is both fragile and exactly the "kill whatever looks right"
shape `live-view-process.ts`'s header warns against. A pid file written
by the process itself is one line per entry script and makes attribution
a fact rather than an inference.

## What the record cannot say yet: network policy

`src/brain/adapters/claude-code.ts` really does choose a per-call
network policy (`prepareNetwork`: the relay-backed isolated network when
a worker token is present, `"allowed"` otherwise) — but nothing records
it. `Brain.work`/`BrainWorkResult` are ratified contract shapes with
nowhere to carry it, and the relay's own `network-refused` bookkeeping
is pointed at a throwaway scratch record home precisely because
`Brain.ask`/`work` take no task id (that adapter's own header states the
gap). So the column shows the only network fact the record holds: the
`network-refused` events attributed to this task, and "not recorded"
when there are none. It will show a real policy the day one is recorded,
and until then it does not pretend to know one.

## Running the suite with no `node_modules` (useful, and a real limit)

This task ran in a sandbox where npm is blocked (`403 Forbidden` on the
registry for every package, `npm install` included), so `npm test` —
which begins with `tsc --noEmit` and then runs everything through
`tsx` — could not run at all, and **this change has never been
typechecked**.

What does work, and is worth knowing for the next agent in the same
position: **Node 24 strips TypeScript natively**, so `node --test
$(find src contract integrations -name '*.test.ts')` runs most of this
suite with no dependencies installed. Two kinds of test can't:

- anything that spawns a detached child, because
  `src/cli/tsx-bootstrap.mjs` really does `import "tsx/esm"` — the
  whole of `do`/`answer`/`verdict fix`'s process layer, the live
  view's two detached-round tests, `src/record`'s concurrent-append
  proof, and `src/line`'s parallel-isolation test;
- anything that reads a real `projects.toml`, because `src/config`
  imports `smol-toml`.

A throwaway `node_modules/smol-toml` stub whose `parse` *throws* gets
the second group to fail loudly rather than pass for the wrong reason,
which is how the handful of config-dependent failures in this run were
told apart from real ones. Delete it afterwards — a fake dependency
left on disk is worse than none.

Running that way, everything this change touches passes: the contract
suite (35), `src/foreman` (203 of 204 — the one failure is the TOML
stub), the live view's own four suites, `src/cli`'s await/render/
skill-settings, `src/brain`, and Herdr's watcher. Node's type stripping
does **not** typecheck, so `tsc --noEmit` on a machine with the real
dependencies is still the first thing to run against this branch.

## Two things that now both want the word "stopped"

`record-view.ts`'s `DisplayState` has had a `"stopped"` label since
issue #26 — for `stateOf`'s `"refused"`, i.e. Inspector reaching no
verdict. Its own comment quotes a Client ruling: keep "stopped" only for
a task that was actually stopped. Nothing could actually stop a task
then; now something can. Rather than re-label an already-ruled-on,
already-tested word, the owner's stop renders as its own
`"stopped by you"`, and the collision is flagged for the Client rather
than resolved unilaterally.

## What landed, in one list

- `src/inspector/types.ts` — the one place Fabrica widens the ratified
  record shapes — gains the `stopped-by-owner` event name and the
  `stopped` task state. Nothing in `contract/` was touched: the issue
  #12 precedent (reuse an existing event name rather than edit a
  CI-protected path) does not apply, because no existing event means
  "the owner stopped this," but the local widening point does the job
  without the contract.
- `src/foreman/stop.ts` + `stateOf`'s absorbing `"stopped"` branch.
- `src/cli/task-process.ts` + a `worker.pid` written by all three
  detached entry scripts.
- `caps.json`, written once at registration (`src/foreman/ask.ts`), so
  the cost meter measures against the cap the task actually started
  under rather than today's `projects.toml`.
- `POST /api/review/tasks/<id>/stop`, and `/api/review` now answering
  `running` and `identified` beside its existing `rows`.
- The list pages' twelve columns, one DOM, two layouts.
- Terminal everywhere it matters: `fabrica status` stops listing a
  stopped task, `fabrica watch` exits on it, `fabrica await` returns,
  `fabrica log` has prose for the event, the live view files it under
  history, and Herdr releases its pane.
