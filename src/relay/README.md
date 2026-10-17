# relay

The first half of issue #186: a relay a worker box's traffic is forced
through, instead of reaching the network itself. This module is the
relay and the policy it enforces; `src/containment/isolated-network.ts`
and `container/launch.ts` are the Docker-side halves that make "forced
through" actually true rather than a convention a worker could ignore.

## What's in scope here, and what isn't

This half builds and tests the mechanism on its own - the issue's own
acceptance shape, "a fake worker and a fake provider" (`server.test.ts`,
`helpers/fake-provider.ts`) - and, as of a later, scoped-down slice of
issue #186's second half, wires the reference CLI adapter's own
`connectThroughRelay`/`prepareNetwork` helpers (`src/brain/adapters/`) to
actually run every real call through it. Still missing, and still
deferred to whoever picks up the rest of #186's second half: a real
place to configure a credential per *project*
(`projects.toml` - the adapter's credential today is still the one
`defaultBrainAdapter` already reads from the host or `brain.env`, just
no longer forwarded into the worker's container raw) and a `fabrica
doctor` check that the mechanism is healthy before a task starts.

## Why not the third-party sandboxing/proxy tool the issue named

Per instruction, that tool (an OS-level sandboxing CLI and library,
published by a model vendor, that also runs a network proxy half
independently of its own sandboxing) was tried first - evaluated by
reading its current documentation (no internet-connected Docker daemon
was available to actually install and run it here - see "What's
verified, what isn't" below) rather than guessing at its shape. It is a
genuinely close match on paper: a standalone proxy mode meant to be
deployed independently of its own OS-level sandboxing, domain
allowlisting with named denial reasons, and - the one capability this
issue most needs - a credential-masking mechanism that swaps a sentinel
value for a real one on the way to an allowed host. Rejected anyway,
for reasons that would have surfaced partway into integrating it, not
before. (This section itself cannot name the tool or its package: rule
8's own scan, described in the third bullet below, applies to this file
too.)

- **Its credential masking requires TLS termination.** It only swaps a
  credential inside a request it can read, which means terminating the
  worker's TLS itself and trusting a man-in-the-middle certificate
  inside the worker's container. This module's own gateway mode (below)
  gets the same swap with no TLS termination at all, by never tunneling
  the credential-bearing traffic end-to-end in the first place - a
  smaller, more obviously correct mechanism for the one case that
  needed it.
- **It is the dependency question, one step early.** Adopting it means
  adding a new package to `package.json` - precisely "the dependencies
  question" this round was told to leave for the second half. Writing
  the relay on Node's own `http`/`https`/`net` modules instead needed no
  such decision and adds nothing to `package.json`.
- **Its own package name fails this repo's rule 8 scan.** `contract/
  rule8.no-favorite-brain.test.ts` flags its publisher's name as plain
  text anywhere under `src/` outside `adapters/` - including an import
  specifier. Importing it from a generic, brain-agnostic module (which
  this has to be - the model provider's own host name is adapter-only
  knowledge, see "The model provider's host is never named here" below)
  would fail that test by construction, not by an oversight fixable
  with a comment.
- **Its sandboxing model doesn't match this one.** Its own isolation is
  OS-level (two different platform-native sandboxing primitives) with
  the proxy wired in via inherited file descriptors from a process it
  also launched. This project's worker boxes are already Docker
  containers (`src/containment/`, issue #44, chosen over a macOS-only
  native sandboxing primitive for reasons `src/containment/README.md`
  already gives) - there is no native process here for that tool to
  sandbox, and retrofitting its file-descriptor-passing contract onto a
  Docker-network boundary would be building around the tool rather than
  with it.

None of this is a verdict on the tool in general - it is a real,
actively maintained project solving a closely related problem. It just
doesn't fit this codebase's existing shape without first answering
questions (the dependency, the TLS trust store inside the worker image)
that belong to later issues.

## Two traffic shapes, handled differently on purpose

- **Tunnel mode** (`CONNECT`): the relay checks the requested
  `host:port` against a short, fixed allowlist (`allowlist.ts`) and, if
  it matches, pipes raw bytes between the worker and that host
  untouched. It cannot see or alter anything inside the tunnel - which
  also means it cannot swap a credential riding inside one. This is
  what GitHub traffic uses: a worker's git client already knows how to
  speak `HTTP_PROXY`/`HTTPS_PROXY`, and nothing it sends to GitHub needs
  a credential swap (`src/line/worktree-git.ts`'s sanitized git config
  already strips any credential-bearing section before a worker ever
  sees `.git/config` - see that file's own README section).
- **Gateway mode** (anything else): the relay forwards every such
  request to the *one* upstream it was configured with
  (`GatewayTarget`), after overwriting one header with the real
  credential. This is how "swaps a per-task fake key for the real one"
  (issue #186) actually happens, with no TLS termination anywhere: the
  worker's HTTP client has its base URL pointed at the relay itself (an
  adapter-level choice, not this module's concern), so there is no
  destination to parse out of the request - the configured upstream
  *is* the destination, and the worker-to-relay leg never needs to be
  more than plain HTTP, since nothing outside the isolated network
  (below) can observe it. The relay's own leg to the real upstream is
  real TLS by default (`GatewayTarget.tls`, defaults to true).

A disallowed tunnel target is refused (`403`) and recorded: a
`"network-refused"` event (`contract/surface.ts`), `details: { host,
port }`, naming exactly what the worker box tried to reach. There is no
equivalent refusal for gateway mode - a relay with no `gateway`
configured just answers every non-`CONNECT` request `501`, since there
is nowhere to send it, not because some host was turned away.

### The model provider's host is never named here

CONTRACT rule 8 ("No favorite brain") means no brain, model, or vendor
name may appear anywhere under `src/` outside `src/brain/adapters/`.
This module is deliberately brain-agnostic as a result: `allowlist.ts`
exports `GITHUB_HOSTS` (GitHub is a destination, not a brain, so it's
fine here), but the model provider's own hostname is never a constant
in this module - it is whatever host a caller's `GatewayTarget` names.
The "short, fixed list" issue #186 asks for is therefore assembled at
the call site (the reference adapter's own provider-host constant, in
`src/brain/adapters/` - see "What's in scope here, and what isn't"
above), not inside `src/relay/` itself.

## The isolated network: `src/containment/isolated-network.ts`

"All traffic goes through that relay" has to be true even if a worker
tries to ignore its proxy configuration, not just true by convention.
`createIsolatedNetwork` makes a Docker network with `--internal`:
documented plainly ("Containers on an internal network may communicate
between each other, but not with any other network, as no default
route is configured and firewall rules are set up to drop all traffic
to or from other networks" -
<https://docs.docker.com/reference/cli/docker/network/create/>) as
having no route anywhere outside itself. `src/containment/
docker-args.ts`'s `network` option gained a third shape, `{
isolatedNetwork: string }`, alongside `"denied"`/`"allowed"`, for
exactly this: attach the worker's container to that network instead of
either extreme.

## Why the relay is the container with two networks, not the worker

An earlier version of this module additionally leaned on the same
`docker network create` reference's "the host may communicate with any
container IP directly," reasoning that a network's gateway IP is the
host's own interface on the bridge, so a relay *process* (not a
container) could bind there and a worker's container could reach it.
That is true on native Linux Docker - and **false on Docker Desktop
(Mac/Windows)**, proven on the Client's own Mac on 2026-10-17: a
container on an `--internal` network cannot reach the host at all,
neither via the gateway address (the Docker Desktop VM owns it, not the
Mac) nor via `host.docker.internal` (`--internal` strips the route
Docker Desktop otherwise sets up for that name). The relay therefore has
to run as a container too - something a container on the isolated
network can actually reach, since "containers on an internal network
may communicate between each other" is the one part of `--internal`'s
own documented behavior that was never in question.

That still leaves a relay container needing its own route to the real
internet, which the isolated network by definition doesn't have. Two
ways to give it one were weighed:

- **The relay is its own container, attached to the isolated network
  *and* a second, separate (non-internal) network as its own egress
  leg.** The worker's container keeps exactly one network interface -
  the isolated one, proven to have no route out at all.
- **The worker's container gets a second network instead - a plain,
  non-internal one whose only other member is the relay.**

The first is what's built here (`container/launch.ts`,
`src/containment/egress-network.ts`), and it's the smaller trust
surface: a non-internal Docker bridge network isn't a point-to-point
link to "the other thing on it" - it's an ordinary network with a real
default route, NAT'd to the internet for *everything* attached to it.
Giving the worker a second interface on one, even one with only the
relay as its other member, would hand the worker its own route to
anywhere on the internet through that network's own gateway, with
nothing to stop it bypassing the relay (its allowlisting, its
credential-scoping) entirely - exactly the guarantee `--internal` exists
to provide, undone by the fix. The relay container is Fabrica's own
trusted code, not anything a worker (or a model acting inside one)
drives directly, so it being the one thing with a real route out costs
nothing a worker could exploit; the worker never gains a second network
or a second idea about where to send a request.

`container/launch.ts` doesn't build or maintain a bespoke relay image:
it bind-mounts the running Fabrica checkout itself (read-only) into a
stock, digest-pinned Node image and runs the relay straight from its
own TypeScript source via `tsx`, the same way `fabrica` already runs
itself (`src/cli/bin.mjs`) - see that file's own header for the full
reasoning and why nothing here needs rebuilding when the relay's code
changes. Neither side of the control plane (confirming the container is
listening, reading its address on the isolated network) touches the
network at all - both are read through the Docker CLI/API (`docker
logs`, `docker inspect`), which works regardless of the same
Docker-Desktop host/VM boundary that broke the old design, since it's
never network traffic in the first place.

### What's verified, what isn't

Every Docker-specific claim above is sourced from Docker's own current
reference docs, read for this change rather than assumed - the
`--internal` quote above, the `docker run`/`docker network connect`
pages' confirmation that a container can be attached to more than one
network, and the `docker inspect`/`docker network inspect` field shapes
(`NetworkSettings.Networks.<name>.IPAddress`) `container/launch.ts`
reads back. The Docker-Desktop-specific fact itself (a container on an
`--internal` network can reach neither the gateway address nor
`host.docker.internal`) is not documentation - it's the Client's own
report from testing directly on their Mac on 2026-10-17, which is what
this redesign exists to fix. No Docker daemon was reachable on the
machine these files were last edited from to additionally verify any of
it live. `isolated-network.test.ts`, `egress-network.test.ts`, and
`docker-isolation.test.ts` (the containerized "worker reaches the relay
container, not the open internet, and the relay container itself
reaches the real internet" proof) all skip rather than fail when
`docker info` doesn't succeed - the same convention `src/containment/
run.test.ts` already established for its own daemon-dependent tests,
not a new exception carved out for this module. They are written to run
for real wherever Docker actually is - the Client's own Mac being
exactly the case this redesign is for - and will; until then, treat the
Docker-network half as documented-and-reasoned, not machine-verified,
which this repository's own culture of "verified live, not assumed"
means stating plainly rather than leaving implicit.

## Files

| File | What it is |
| --- | --- |
| `types.ts` | `AllowedHost`, `CredentialSwap`, `GatewayTarget`, `RelayOptions`, `RelayHandle` - this module's own configuration shapes, not shared with `contract/surface.ts` except by `FabricaEventName` gaining `"network-refused"` there. |
| `allowlist.ts` | `GITHUB_HOSTS` and `isAllowedTarget` - hostname matching (exact or one level of `*.` wildcard, optional port), used by tunnel mode. |
| `server.ts` | `startRelay` - the relay itself: the `CONNECT` tunnel handler and the gateway forwarder, plus the `"network-refused"` event. Runs identically whether started in-process (this module's own fast tests) or inside `container/`'s own container. |
| `errors.ts` | `RelayError` - `"invalid-config"` (a malformed `GatewayTarget`) and `"listen-failed"` (also used for a container that never starts or never confirms it's listening). |
| `container/` | Runs the relay as its own Docker container instead of a host process - see "Why the relay is the container with two networks" above. `types.ts` (`ContainerizedRelayOptions`/`Handle`, the fixed in-container port), `launch.ts` (`startContainerizedRelay` - the host side), `entrypoint.ts` (runs inside the container), `bootstrap.mjs` (teaches that fresh `node` process TypeScript, the same way `src/cli/bin.mjs` does for `fabrica` itself). |
| `helpers/fake-provider.ts` | Test-only: a plain-HTTP stand-in for "the model provider," recording every request it receives so a test can assert on exactly what crossed the wire. |
| `server.test.ts` | The fake-worker/fake-provider proof: gateway credential swap, tunnel allow/refuse, the refusal event, per-task event isolation. |
| `docker-isolation.test.ts` | The containerized proof: a real worker box, on the isolated network, reaches the relay container and nothing else; the relay container itself reaches the real internet through its own egress network. |
