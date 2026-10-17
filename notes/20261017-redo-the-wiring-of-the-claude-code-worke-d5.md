## Redoing issue #186's relay wiring: the relay has to be a container

Context for whoever folds this into AGENTS.md: PR #216 built `src/relay/`
and `src/containment/isolated-network.ts` on the premise (from Docker's
own docs, "the host may communicate with any container IP directly")
that a host process could bind to an `--internal` network's own gateway
address and a container on that network would reach it there. PR #220
then wired `src/brain/adapters/claude-code.ts` to that mechanism. It was
reverted (PR #225, reverting #220) because of a fact the Client proved
by testing directly on their own Mac on 2026-10-17: **a container on a
Docker `--internal` network cannot reach the host machine at all** -
not via that network's gateway address (the Docker Desktop VM owns it,
not the Mac itself) and not via `host.docker.internal` (`--internal`
strips the route Docker Desktop otherwise sets up for that name). The
old design only ever worked on native Linux Docker; Docker Desktop
(Mac/Windows) was broken by construction.

This task redid the wiring so the relay is a **container**, not a host
process - something a container on the isolated network can actually
reach, since "containers on an internal network may communicate between
each other" is the one part of `--internal`'s documented behavior that
was never in question, true on Linux and Docker Desktop alike. The relay
container gets a *second*, separate (non-internal) network as its own
route to the real internet; the worker keeps exactly one network
interface, the isolated one.

Two ways to give the relay a route out were weighed (see
`src/relay/README.md`'s "Why the relay is the container with two
networks" for the full writeup, and `claude-code.md`'s "Process
containment" section for how the adapter wires it): the relay container
with two networks (chosen), vs. giving the *worker's* container a
second, non-internal network whose only other member is the relay.
Rejected: a non-internal Docker bridge network isn't a point-to-point
link to one other container - it's an ordinary network with a real NAT
route to the internet for *everything* on it, so the worker would gain
its own way to bypass the relay entirely through that network's own
gateway. The relay is Fabrica's own trusted code, not anything a worker
drives, so it being the one thing with real egress costs nothing a
worker could exploit; the worker never gains a second network.

### What changed, file by file

- `src/containment/isolated-network.ts`: no longer looks up or returns a
  gateway IP at all - nothing binds there any more. Doc comment
  rewritten to state the proven Mac fact plainly instead of the now-false
  "the host may communicate with any container IP directly" reasoning.
- `src/containment/egress-network.ts` (new): a plain, non-`--internal`
  bridge network - the relay container's own second leg. `docker-args.ts`
  and `types.ts`'s doc comments updated to match.
- `src/relay/container/` (new): `types.ts` (`ContainerizedRelayOptions`/
  `Handle`, the fixed in-container port `CONTAINER_RELAY_PORT`),
  `launch.ts` (`startContainerizedRelay` - the host side: starts the
  container, waits for it to report listening via `docker logs`, reads
  its address on the isolated network via `docker inspect`, both
  deliberately not a TCP probe since nothing on a Docker-Desktop host
  can reach into the container directly either), `entrypoint.ts` (runs
  inside the container, reads config from one env var,
  `FABRICA_RELAY_CONFIG`, delivered through a throwaway `--env-file` so
  a real credential never touches `docker run`'s argv or a host `ps`
  listing), `bootstrap.mjs` (teaches that fresh `node` process
  TypeScript, mirroring `src/cli/bin.mjs`'s own proven pattern exactly -
  `import "tsx/esm"` resolved against the file's own location, never
  `node --import tsx/esm`, which `bin.mjs`'s own comment already
  documents as cwd-relative and wrong). No new Docker image to build or
  go stale: it bind-mounts the running Fabrica checkout (read-only) into
  a stock, digest-pinned Node image - the same digest already pinned in
  `src/brain/adapters/docker/Dockerfile`'s own `FROM` line, reused rather
  than looked up fresh (`relay-image-digest.test.ts` proves the two stay
  in sync).
- `src/brain/adapters/claude-code.ts`: `connectThroughRelay`/
  `prepareNetwork` redone to create both networks and start the
  containerized relay instead of a host-process one; otherwise the same
  shape as PR #220 (per-call placeholder, `ANTHROPIC_BASE_URL`/
  `ANTHROPIC_AUTH_TOKEN`, GitHub tunnel allowlist, teardown in `finally`).
- Tests: `src/containment/egress-network.test.ts` (new),
  `src/containment/isolated-network.test.ts` (dropped the gateway-IP
  assertion), `src/relay/docker-isolation.test.ts` (rewritten against
  the containerized relay, plus a new test proving the relay's own
  egress leg reaches the real internet), `src/relay/container/
  relay-image-digest.test.ts` (new), `src/brain/adapters/
  claude-code.test.ts` (reinstated the two "never forwards the real
  token" tests from PR #220, same assertions). All Docker-dependent
  tests skip, never fail, without a daemon - confirmed by running
  `npm test` in this task's own sandbox, which has no `docker` binary at
  all (no socket, no CLI - consistent with `src/containment/README.md`'s
  "the Docker socket never mounted" for a worker's own box). They are
  written to run for real wherever Docker actually is; that is the
  Client's own Mac, which is the one place this redesign's actual claim
  - "a worker reaches the relay container, never the open internet, and
  the relay container's own egress leg reaches the real internet" - can
  currently be proven live.

### Stale AGENTS.md text this should eventually correct

The existing `src/relay/` bullet in AGENTS.md (as of the pre-#220-revert
state) still describes the host-process-bound-to-gateway-IP design as
current, including the sentence "a `docker network create --internal`
network ... whose own gateway IP ... is where the relay binds." That is
now wrong - the relay binds inside its own container, not at that
address, and the gateway IP is never read or used at all any more.
Whoever folds this note in should replace that sentence and the
surrounding paragraph's description of the wiring with the shape above
(or just point at `src/relay/README.md`, which now carries the full
reasoning) rather than re-deriving it from scratch.
