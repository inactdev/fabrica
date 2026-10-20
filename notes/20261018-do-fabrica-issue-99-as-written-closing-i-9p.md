# `fabrica status`/`watch` read the worker's process, not just the record (issue #99)

Before this, both commands could only describe the record, and said so
honestly: "quiet 3m, no signal since last heartbeat - not known to be
stuck, not known to be fine". That is the end of what the record can
say, because a worker killed by a reboot, an OOM or a `kill -9` leaves
exactly the same silence as one thinking hard, forever.

Both commands now really look. The durable facts worth keeping:

- **The verification is issue #203's, reused, not re-implemented.**
  `src/cli/task-process.ts`'s `probeTaskWorker` wraps `findTaskProcess`
  (the task's own `worker.pid`, trusted only once that pid is alive AND
  still running one of the three detached runners). A command that only
  *reports* must never be more trusting than the one that *signals*, so
  there is exactly one definition of "this pid is this task's worker".
- **Three readings, not a boolean.** `alive` (nothing new is printed -
  a healthy line reads exactly as it did before), `not-found` ("worker
  process not found ...", in place of any quiet or mid-check notice),
  `unknown` (the record's own notice plus "liveness unknown (started
  before pid files)"). `unknown` covers no pid file at all AND no usable
  process table - `listProcesses` degrades to `[]` when there is no `ps`
  it can run, and an empty table is never the truth since the asking
  process is in it. Collapsing either into `not-found` would be the same
  inference-from-nothing this change removes, with a more confident
  voice.
- **`expectsWorkerProcess` (`render.ts`) is the one gate on who gets
  looked at**: state `working`/`checking`, AND this round's
  `"work-started"` is the last round-boundary event. A
  `"verdict-recorded"`/`"answers-given"` after it means the round has
  been decided but its detached process may not have started yet, while
  the pid file still names the *previous* round's long-exited one - so
  without that second condition every `fabrica verdict <id> fix` would
  report a false death for the length of a spawn. Deliberately derived
  from the record's own event order, not from a timestamp or a grace
  period.
- **Client ruling (clarifications on issue #99), all four parts:**
  report only - neither command writes to the record, the same rule the
  live view follows; `fabrica status` keeps exit 0 and marks the row;
  `fabrica watch` prints the not-alive notice *once* and keeps polling,
  since the record may still gain a `task-failed`; the marker is
  human-readable only, with no new machine-readable field. The
  worker-gone wording deliberately names no command to run - unlike
  every other notice in `render.ts` - because a "working" task has no
  delivery, so `fabrica verdict <id> wrong` would be refused as
  `not-delivered`, and pointing the Client at a command that bounces is
  worse than pointing him nowhere.
- **The sentence is still `describeLiveness`'s alone** (it takes the
  reading as a parameter); each command decides only *when* to look and
  *when* to print. That file's history is of `status` and `watch`
  re-deriving the same wording independently and drifting apart, which
  is why the process reading went into it rather than into the two
  commands.
- **Cost discipline, because these two run constantly:** `status` reads
  one process table for the whole listing (`cachedProcessTable`) rather
  than spawning a `ps` per open task, and `watch` - polling twice a
  second - probes at most once per `WORKER_PROBE_INTERVAL_MS` (the
  heartbeat interval: checking a worker's process more often than that
  worker reports in cannot tell the Client anything new).
- **`fabrica watch` may look, never touch.** Its whole safety property
  is that stopping the watch never stops the work, so of
  `task-process.ts`'s exports it imports the probe only, never
  `stopTaskProcess`. Reading a pid file and a `ps` listing is not
  process management; keep it that way.

## Sharp edge for test authors

`src/cli/helpers/fake-run-task-entry.ts` (the test-only stand-in for
`run-task-entry.ts`) deliberately writes **no** pid file, so every task
a test starts through it reads as `unknown` and its `status`/`watch`
lines carry the "liveness unknown" caveat - which is why
`watch-command.test.ts`'s mid-check assertion matches a line *prefix*
rather than a whole line. Do not "fix" this by having the fake write
one: its command line is `helpers/fake-run-task-entry.ts`, which
`commandLineMatchesTask` does not (and must not) match, so a pid file
would turn every fake-runner task into a false "worker process not
found". Tests that want a real reading supply both halves themselves -
the pid file by hand and a `listProcesses` table - the way the new tests
in `task-process.test.ts`, `status-command.test.ts` and
`watch-command.test.ts` do.

## Running the suite with no `node_modules` at all

Observed while doing this task, and useful to anyone working somewhere
the npm registry is unreachable: this repo's tests run under plain
Node's own TypeScript type stripping - `node --test $(find contract src
integrations -name '*.test.ts')`, no `tsx`, no install - because every
import here already carries its `.ts` extension and nothing uses
non-erasable syntax. What that does NOT cover, and why it is a fallback
rather than a substitute for `npm test`:

- no typechecking at all (that is `tsc --noEmit`, which needs the real
  `typescript`), so a type error passes silently;
- every test that spawns a real process through `bin.mjs`/
  `tsx-bootstrap.mjs` fails on `Cannot find package 'tsx'` - all of
  `do-command`, `spawn-detached`, `answer-command`, `verdict-command`'s
  detached halves, the live view's verdict/answer POSTs, the
  `record`/`line` concurrency proofs that spawn `tsx` workers, and the
  two "mid-check" tests in `status-command`/`watch-command` that need a
  real detached worker;
- `src/config` needs `smol-toml`, so those tests need it present.

## Deliberately left alone

`integrations/live-view/`'s own task rows still derive liveness from the
record alone (`record-view.ts` keeps its small copies of this wording
because that integration reaches Fabrica only through `src/index.ts`).
Issue #99 named `fabrica status` and `fabrica watch`; giving the live
view the same reading is a separate change, and it would need
`probeTaskWorker` exported from `src/index.ts` first - today it lives
under `src/cli/`, which the live view only reaches into for the one
already-ruled exception, `stop` (`findTaskProcess`/`stopTaskProcess`).
