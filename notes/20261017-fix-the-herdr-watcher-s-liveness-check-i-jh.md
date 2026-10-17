# A pid that answers signal 0 is not necessarily a running process

`integrations/herdr/herdr-watcher.ts`'s `isProcessAlive` used
`process.kill(pid, 0)` alone, the same way `src/cli/live-view-process.ts`
does. That call cannot see a zombie - a process that has exited but
whose parent hasn't reaped it - and a zombie is exactly what a dead
Herdr watcher leaves behind: `fabrica up` spawns the watcher detached and
then blocks in the foreground harness session, so its own event loop
never iterates again to collect the child's exit status (libuv's SIGCHLD
handler only writes to a pipe; the `waitpid` happens on the next loop
turn). The zombie therefore persists for the whole life of that
`fabrica up` - the Client saw pid 57418 `<defunct>` with three days
elapsed, with `fabrica up` reporting nothing and never starting a
replacement watcher.

Reproduced here before fixing, on this project's own Linux container:
with a parent blocked in `Atomics.wait`, `process.kill(childPid, 0)`
succeeds while `/proc/<childPid>/stat` reads
`127 (MainThread) Z 120 ...`.

## How it's read now, and why only in one direction

`/proc/<pid>/stat` where `/proc` exists (Linux, including the BusyBox
container the tests run in - whose `ps` knows neither `-o state` nor
`-p`), otherwise `ps -o state= -p <pid>`. A state positively read as
starting with `Z` means exited; **null ("couldn't tell") keeps whatever
signal 0 said**. The asymmetry is the point: a false "exited" makes
`fabrica up` start a second watcher next to a healthy one and duplicate
every Herdr tab, which is worse than the bug being fixed.

Two alternatives were weighed and rejected:

- **A freshness stamp** (the watcher rewrites its pid file every poll;
  a stale mtime reads as dead). Platform-independent, and it would also
  catch a *hung* watcher and pid reuse - but this runs on the Client's
  Mac, which sleeps (that's why `src/containment/caffeinate.ts` exists),
  and a genuinely live watcher looks stale the moment the machine wakes.
  Time-based liveness has a false-positive mode; state-based doesn't.
- **Command-line matching**, the way `live-view-process.ts` already
  double-checks a pid against `ps -A -o pid,args`. It would fix zombies
  *and* pid reuse (a zombie's `args` degrades to `[name] <defunct>`), but
  its macOS behaviour isn't documentable from inside a worker box, and
  it's a larger change than the brief. Worth noting that this is why
  `live-view-process.ts` does **not** have the same bug: its own
  marker-match rejects a zombie even though its `isProcessAlive` is the
  naive one. Don't "fix" that file by copying this change into it
  without first checking whether it changes that behaviour.

## Sharp edges for whoever touches this next

- **`/proc/<pid>/stat` cannot be split from the left.** Field 2 (`comm`)
  is parenthesised and may itself contain spaces and parentheses, so the
  state field is only findable after the **last** `)`. Node's own child
  processes make this concrete rather than theoretical: the comm observed
  here was `(MainThread)`.
- **A zombie can't be made from inside a test process.** Node reaps a
  spawned child as soon as its event loop iterates, and a test has to
  keep polling. `helpers/zombie-parent.mjs` is the separate blocked
  parent that makes one and keeps it; its pid is handed over through a
  file, not stdout, because a piped `process.stdout.write` is documented
  as asynchronous on macOS and nothing asynchronous can complete after
  that block.
- **The test asserts the zombie still answers signal 0** before
  asserting the status is `"exited"`. Without that precondition the test
  would silently degrade into a duplicate of the plain dead-pid test
  beside it the day Node starts reaping differently. Checked against the
  pre-fix code as a negative control: it fails with
  `actual: 'running', expected: 'exited'`.

## Sandbox limitation worth knowing

This worker box has no npm registry access (403 on every package) and so
no `node_modules` - `npm test` can't run at all, since it starts with
`tsc --noEmit` and then needs `tsx`. Node 24's own type stripping runs
the suite instead: `node --test <file.test.ts>` works directly on this
project's TypeScript. The only blocker is that `src/index.ts` pulls in
`smol-toml` transitively (via `src/config/load.ts`), so a local throwaway
stub under the gitignored `node_modules/` is needed to make the module
graph resolve for tests that never parse TOML. Suites that do reach real
config parsing (e.g. `src/cli/up-command.test.ts`, which stops at the
`fabrica doctor` gate) fail for that reason here, not from the code under
test - the Docker-equipped CI judge (`.github/workflows/docker-tests.yml`)
is the one that runs the real thing.
