# A stopped container still holds the network; a fake `docker` on PATH tests that

Two durable facts came out of fixing `src/relay/container/launch.ts`'s
failure-path cleanup.

## Stopping a container is not removing it, and the difference leaks networks

`docker run --rm` only reaps a container that actually *started and then
exited*, and `docker stop` returns before the daemon's own reap of it
necessarily has. So a relay container could sit in `docker ps -a` after
Fabrica believed it had cleaned up - and, still attached to the isolated
network, make that network's own removal fail, because Docker refuses to
remove a network a container is attached to. `src/brain/adapters/
claude-code.ts`'s teardown runs `relay.close()` and then
`removeIsolatedNetwork`/`removeEgressNetwork`, so the leak came in pairs:
after the 2026-10-17 proof runs the Client's machine held a leftover
`fabrica-relay-<id>` container *and* three
`fabrica-worker-<id>`/`fabrica-relay-egress-<id>` networks.

`launch.ts` now takes `docker rm -f` to the container on every path that
can throw once `docker run` has been attempted (one `try` opening at the
run, so no path can be forgotten), swallowing a failed removal - the
error already heading for the Client is the one worth reporting. Two
ordering rules worth keeping if this code is touched again:

- **Read the logs before removing.** The `"listen-failed"` message
  carries the tail of `docker logs`, which is the only account of why the
  relay never listened; `waitForListening` reads it before it throws and
  the removal happens in the caller's `catch`, after.
- **`--rm` stays.** Owning removal outright (dropping `--rm`) was
  considered and rejected: if the Fabrica process dies between `run` and
  `rm`, `--rm` is the only thing that still cleans up.

The success path (`close()`) still does `docker stop` and was left alone
- the brief scoped this to pre-listening failures - but the same
stop-isn't-removal reasoning applies to it, and it is the next place to
look if a *successful* run ever leaves a network behind.

## Faking the `docker` CLI: copy a shim onto PATH as `docker`

`launch.ts` reaches Docker through `execFile("docker", ...)`, which
resolves `docker` through `PATH` - so a test can copy
`src/relay/container/helpers/fake-docker.mjs` onto a throwaway directory
as `docker`, `chmod 0o755` it, and prepend that directory to
`process.env.PATH` (restoring it in `t.after`). The production code gets
no seam, no injected exec function, and the test asserts on the exact
argv a real daemon would have received, in arrival order (the fake
appends one JSON array per call to `calls.jsonl`). Two details that
matter:

- Add `dirname(process.execPath)` to the patched `PATH` as well, so the
  shim's own `#!/usr/bin/env node` resolves to the runtime running the
  test rather than depending on `node` being on the ambient `PATH`.
- Use network/container names no real daemon could own
  (`fabrica-test-no-such-network-...`), so if the shim ever fails to take
  effect the test fails loudly instead of quietly driving real Docker.

This is how `src/relay/container/launch.test.ts` runs in the fast suite
with no daemon anywhere - the one test in that module that neither needs
Docker nor skips on it - and it generalizes to any other module that
shells out to a CLI by bare name.

## `node --test` runs this repo's TypeScript tests without `tsx`

Worth knowing when `node_modules` can't be installed (this box had no
registry access, so no `tsx` and no `tsc`): Node 24 strips types
natively, and `node --test $(find src -name '*.test.ts')` ran the relay,
containment and brain suites unchanged. It is **not** a substitute for
`npm test` - there is no typechecking at all, which is the first half of
that script - but it does let a test be driven, and proven to fail
against the pre-fix behavior, where `npm test` can't run.
