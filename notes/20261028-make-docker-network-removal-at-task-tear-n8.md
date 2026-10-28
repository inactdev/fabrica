# Removing a Docker network that is already gone is success

A round's teardown removes the two networks it opened (the worker's
`--internal` one and the relay's egress leg) from the adapter's own
`finally` — `src/brain/adapters/claude-code.ts`'s and
`openai-compatible.ts`'s `prepared.teardown()`. Until now
`removeIsolatedNetwork`/`removeEgressNetwork` threw
`ContainmentError("network-remove-failed")` on *any* docker failure,
including docker saying the network is not there. Thrown from a
`finally`, that replaces the round's real result with a plumbing error,
so a task whose work had finished fine failed anyway. Seen on task
`20261028-re-apply-the-change-on-branch-fabrica-20-ij`.

"Already gone" is a normal thing to meet here, not an anomaly: the
Foreman's own end-of-round sweep (`src/foreman/task-networks.ts` →
`removeTaskNetworks`) removes the same two networks by their
`fabrica.task` label, and it exists precisely because the adapter's
`finally` cannot be relied on. Whichever of the two gets there second
finds nothing, and there is nothing left to report — the desired state
is reached.

## The choice made, and the one rejected

**Chosen:** keep the `docker network rm <name>` call byte-for-byte as it
was and widen only the interpretation of its failure — docker's own
"not found" / "no such network" wording means the network is gone, which
is success; every other wording still throws exactly as before. This
adds no new flag or argument to an outside tool, which matters because
docker's current CLI reference was not reachable from where this was
written, and it is the Client's own framing of the fix. Its failure mode
is loud: a wording docker changes later stops matching and the old throw
comes back, rather than a removal being silently believed.

**Rejected:** passing `-f` to `docker network rm`, the way
`task-networks.ts`'s own `removeNetwork` already does. It is the
docker-native answer and would be one character of change, but it
asserts a flag's semantics ("do not error if the network does not
exist") that could not be re-read from docker's current documentation
here — only from this repo's own earlier note of it — and it would also
swallow whatever else `--force` might come to mean. The brief scopes the
fix to "not found"; `-f` is wider than the brief.

## Why the fake docker had to change too

`src/containment/helpers/fake-docker.mjs` treated `network rm` of a
network it did not have as success **regardless of `-f`**, so a test of
this fix against the fake would have passed before the fix as well. The
fake now models the real CLI on both sides of that flag: with `-f`, a
missing network is silent success; without it, exit 1 and
`Error response from daemon: network <name> not found`. That also closes
a real fake-vs-real drift — every pre-existing caller through the fake
(`removeTaskNetworks`) passes `-f`, so none of them change behaviour.

## Same shape elsewhere

- `src/containment/task-networks.ts`'s `removeNetwork` — already
  tolerant (passes `-f`, and never throws at all: it returns docker's
  reason for the sweep to report). Unchanged.
- `src/relay/container/launch.ts` — `docker rm -f <container>` and
  `docker stop <container>` are both already `.catch(() => {})`.
  Unchanged.
- Both adapters' *failure*-path network removal
  (`claude-code.ts`/`openai-compatible.ts`, right after
  `startContainerizedRelay` throws) was already `.catch(() => {})`; only
  the success-path `teardown()` threw, and that is what this fixes.
- `src/line/teardown.ts`'s `destroyProductionLine` is the existing
  precedent in this codebase for the same rule on the git side: a second
  teardown of the same line is `already-destroyed`, an idempotent
  success, not a throw.
