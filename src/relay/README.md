# relay

Issue #186: a relay a worker box's traffic is forced through, instead of
reaching the network itself. This module is the relay and the policy it
enforces; `src/containment/isolated-network.ts` and
`container/launch.ts` are the Docker-side halves that make "forced
through" actually true rather than a convention a worker could ignore.

## What's in scope here, and what isn't

The mechanism is tested on its own - the issue's own acceptance shape,
"a fake worker and a fake provider" (`server.test.ts`,
`helpers/fake-provider.ts`) - and the reference CLI adapter's
`connectThroughRelay`/`prepareNetwork` helpers (`src/brain/adapters/`)
run every real call through it.

Issue #186's second half added the policy around that mechanism:

- **Per-project allowed hosts** (`policy.ts` here,
  `src/foreman/network-policy.ts` for the projects.toml side).
- **A refusal on the task's own record**, rather than on a throwaway
  scratch location - see "Which task a refusal belongs to" below.
- **Two limits** - request size, and calls per task (`limits.mjs`).
- **Two `fabrica doctor` lines** - this module's own `relay image`
  (`container/doctor-check.ts`) and the adapter's `worker CLI`
  (`src/brain/adapters/doctor-checks.ts`).
- **A real `npm ci` through the relay** (`npm-ci-in-box.test.ts`,
  Docker-gated) plus a hermetic fake-registry proof of the same
  decision (`npm-registry.test.ts`).

What the issue left to a later one, and this still doesn't do: a
per-project *credential*. The adapter's credential is still the one
`defaultBrainAdapter` reads from the host or `brain.env` - swapped in by
the relay, never forwarded into the worker's container raw, but one
credential for every project rather than one per project.

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
  `host:port` against a short, fixed allowlist (`allowlist.mjs`) and, if
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

## Which hosts, which limits: the project says

A project declares what its Workers may reach, in its own
`projects.toml` entry (`src/config/load.ts`):

    [projects.spending-app]
    path = "~/inkling-umbrella/spending-app"
    check = "./check.sh"
    hosts = ["registry.npmjs.org"]
    maxRequestBytes = 10485760
    maxCallsPerTask = 2000

`hosts` is **additive** (Client ruling, issue #186): the model
provider's own host and GitHub are always allowed, and a project's
entries are added to them. A project that declares none therefore gets
exactly those - never nothing - so an unregistered project, which is
what every contract fixture is, behaves as it always did. An entry is a
host name, optionally one port (`"example.com:8443"`), optionally with
a leading `*.` for one level of subdomain; one that could never match
anything is refused loudly (`RelayError("invalid-config")`) rather than
accepted and silently never matched.

`policy.ts` is the composition (`tunnelAllowlistFor`,
`relayLimitsFor`), deliberately ignorant of what the base hosts are -
the model provider's host is adapter-only knowledge (rule 8), so it
arrives as a parameter. `src/foreman/network-policy.ts` is the other
end: it reads the declaration out of the real `projects.toml`, matching
the project the same way `resolve-check.ts` does.

### The two limits (`limits.mjs`)

| Limit | Default | What happens past it |
| --- | --- | --- |
| `maxRequestBytes` | 10 MB | That one gateway request is refused `413`, and recorded with `details.limit = "request-size"`. |
| `maxCallsPerTask` | 2000 | That call is refused `429`, and recorded once with `details.limit = "calls-per-task"`. |

Neither ever stops the task. Rule 10's spending cap is the only thing
that does (Client ruling, issue #186) - a refused request is one
request, and the Worker is free to carry on without it.

Three properties of this worth knowing before changing it:

- **The size limit cannot apply to tunnel mode.** A `CONNECT` tunnel is
  raw bytes the relay deliberately never looks inside, so there is no
  "request" in it to measure. A declared `content-length` over the
  limit is refused before a byte is forwarded; a chunked body with no
  declared length is measured as it streams and the upstream request
  abandoned mid-flight the moment it goes over.
- **A call is one gateway request or one CONNECT tunnel**, counted per
  relay, which is per task - a relay is started for one task's box and
  torn down with it.
- **The call-limit refusal is recorded once, not once per refused
  call.** `events.jsonl` is shared by every task in a record home and
  is re-read whole by `fabrica status`/`watch`; a Worker looping
  against an exhausted limit would otherwise write an unbounded run of
  identical lines and slow every other task's status down. Later
  refusals still happen; they just add nothing the first one didn't
  already say. A refused *host* is still recorded every time, since
  each one can name a different host.

## Which task a refusal belongs to

`RelayOptions` has always taken a `recordHome` and a `taskId`, but the
adapter had neither: `Brain.ask`/`work` are ratified as
brief/workdir/opts (rule 8's socket), so a refusal used to land in a
throwaway scratch directory and the Client never saw it.

The Foreman now wraps every `brain.ask`/`brain.work` call in that
task's policy (`src/brain/task-network.ts`, an `AsyncLocalStorage`),
and the adapter reads it there - so a refused host appends to the
Client's real record and shows up in `fabrica log <id>`. See that
module's own header for why it is an async-local scope rather than a
new field on `BrainWorkOptions` (a ratified type, and a promise every
future adapter would inherit) or a `workdir`-keyed registry like
`src/brain/live-transcript.ts`'s (`ask()` has no workdir). A call that
nothing wrapped - a library-level caller, a test driving the adapter
directly - still works: it falls back to the old scratch location and
the base hosts alone.

Two consequences of that worth knowing before changing it:

- **The relay container now bind-mounts the Client's real record home
  read-write** (`container/launch.ts` always mounted whatever
  `recordHome` it was given; what changed is which directory that is).
  That is Fabrica's own trusted code - a worker never drives it, and
  the worker's own container mounts nothing of the record at all - but
  it is a real write mount, so nothing in `container/` may grow a
  reason to write anything there but the one event line.
- **Two processes now append to the same `events.jsonl`**: the host
  running the task, and the relay container. That is exactly the case
  `src/record/`'s append-only design was built and proven for (one
  `O_APPEND` write per line, with the proof deliberately spawning
  separate OS processes), and `server.mjs` writes its line the same
  way by hand rather than through `appendEvent` only because it runs
  on a stock `node` with no TypeScript - not because it is allowed to
  write differently.

### The model provider's host is never named here

CONTRACT rule 8 ("No favorite brain") means no brain, model, or vendor
name may appear anywhere under `src/` outside `src/brain/adapters/`.
This module is deliberately brain-agnostic as a result: `allowlist.mjs`
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
own source, so nothing needs rebuilding when the relay's code changes.
Everything the container runs (`container/bootstrap.mjs`,
`container/entrypoint.mjs`, `server.mjs`, `allowlist.mjs`,
`errors.mjs`) is plain JavaScript importing only `node:` built-ins, so
the stock image's `node` runs it as-is - no `tsx`, nothing from
`node_modules`. Those files carry `// @ts-check` and JSDoc types (read
from `types.ts`) so `npm run typecheck` still checks them;
`container/runtime-imports.test.ts` proves they start with plain `node`
from a folder holding nothing else. `server.mjs` writes its
`"network-refused"` line to `<recordHome>/events.jsonl` itself rather
than through `src/record/`'s `appendEvent`, for the same reason - same
line shape, same single `O_APPEND` write. Neither side of the control plane (confirming the container is
listening, reading its address on the isolated network) touches the
network at all - both are read through the Docker CLI/API (`docker
logs`, `docker inspect`), which works regardless of the same
Docker-Desktop host/VM boundary that broke the old design, since it's
never network traffic in the first place.

### A failed launch removes its container, it doesn't just stop it

`container/launch.ts` takes `docker rm -f` to the relay container on
*every* path that can throw once `docker run` has been attempted - the
run itself failing, the container never reporting
`FABRICA-RELAY-LISTENING` inside the timeout, no address on the isolated
network, anything unexpected. It used to stop it instead, which is not
the same thing: `--rm` only reaps a container that actually started and
then exited, and `docker stop` returns before the daemon's own reap
necessarily has, so a container could still be sitting in `docker ps -a`
*attached to the isolated network* - and a network with a container
attached refuses to be removed, so the caller's own teardown then failed
too and leaked both (`src/brain/adapters/`'s reference adapter runs
`removeIsolatedNetwork`/`removeEgressNetwork` right after
`relay.close()`). That is not hypothetical: after the 2026-10-17 proof
runs the Client's machine was
left with a `fabrica-relay-<id>` container and three
`fabrica-worker-<id>`/`fabrica-relay-egress-<id>` networks. The
`"listen-failed"` message still carries the last 500 characters of the
container's own output, because `waitForListening` reads `docker logs`
*before* it throws and the removal happens after - destroying the one
account of why the relay never listened would trade one debugging
problem for another. A removal that itself fails is swallowed, not
reported: the error already on its way to the Client is the one worth
seeing, and the container may legitimately be gone already.

`container/launch.test.ts` proves both of those paths with no Docker
daemon involved at all - `container/helpers/fake-docker.mjs` is copied
onto a throwaway directory as `docker` and that directory put first on
`PATH`, so `launch.ts`'s own `execFile("docker", ...)` calls reach the
fake and a test can assert on the exact argv a real daemon would have
got, in the exact order the calls arrived. Nothing in `launch.ts` was
given a seam to make this testable; only `listenTimeoutMs`
(`container/types.ts`) is new, so the timeout path doesn't cost the fast
suite a real 15-second wait. This is the one test in this module that
neither needs nor skips on Docker.

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

The same goes for `npm-ci-in-box.test.ts`, added by the second half: it
skips without Docker, and `.github/workflows/docker-tests.yml` is what
actually runs it. What *was* verified rather than assumed is the reason
it is written the way it is - npm's own proxy behaviour, read out of
the installed npm (11.16.0) rather than guessed. `@npmcli/config`'s
`https-proxy` definition documents that `HTTPS_PROXY`/`https_proxy`/
`HTTP_PROXY`/`http_proxy` are honored, and `@npmcli/agent/lib/proxy.js`
resolves an `https:` URL's proxy from the lowercased environment and
reaches it through `HttpsProxyAgent`, i.e. `CONNECT`. That is why a
registry a project lists has to be on the *tunnel* allowlist, and why
the box needs no DNS of its own to reach it: a proxy client sends the
host name in the `CONNECT` line and lets the relay resolve it.

## Files

| File | What it is |
| --- | --- |
| `types.ts` | `AllowedHost`, `CredentialSwap`, `GatewayTarget`, `RelayOptions`, `RelayHandle` - this module's own configuration shapes, not shared with `contract/surface.ts` except by `FabricaEventName` gaining `"network-refused"` there. |
| `allowlist.mjs` | `GITHUB_HOSTS` and `isAllowedTarget` - hostname matching (exact or one level of `*.` wildcard, optional port), used by tunnel mode. |
| `limits.mjs` | `DEFAULT_MAX_REQUEST_BYTES` (10 MB) and `DEFAULT_MAX_CALLS_PER_TASK` (2000). Plain JavaScript, because `server.mjs` runs inside the container with a stock `node`. |
| `policy.ts` | `parseAllowedHost`, `tunnelAllowlistFor`, `relayLimitsFor` - a project's declaration composed with the caller's base hosts and the defaults. Pure; no I/O. |
| `server.mjs` | `startRelay` - the relay itself: the `CONNECT` tunnel handler and the gateway forwarder, plus the `"network-refused"` event. Runs identically whether started in-process (this module's own fast tests) or inside `container/`'s own container. |
| `errors.mjs` | `RelayError` - `"invalid-config"` (a malformed `GatewayTarget`) and `"listen-failed"` (also used for a container that never starts or never confirms it's listening). |
| `container/` | Runs the relay as its own Docker container instead of a host process - see "Why the relay is the container with two networks" above. `types.ts` (`ContainerizedRelayOptions`/`Handle`, the fixed in-container port), `launch.ts` (`startContainerizedRelay` - the host side), `entrypoint.mjs` (runs inside the container), `bootstrap.mjs` (the container's command), `runtime-imports.test.ts` (proves the container's files need nothing but plain `node`), `launch.test.ts` + `helpers/fake-docker.mjs` (the daemon-free failure-path proof - see "A failed launch removes its container" above). |
| `helpers/fake-provider.ts` | Test-only: a plain-HTTP stand-in for "the model provider," recording every request it receives so a test can assert on exactly what crossed the wire. |
| `server.test.ts` | The fake-worker/fake-provider proof: gateway credential swap, tunnel allow/refuse, the refusal event, per-task event isolation. |
| `limits.test.ts` | Both limits against a real relay: refused with the right status, named on the record, and the task able to carry on afterwards. |
| `policy.test.ts` | The composition: additive hosts, ports, a host nothing could match, and the defaults. |
| `npm-registry.test.ts` | Hermetic: a real `projects.toml` through `networkPolicyFor` into a real relay decision, against a fake registry. No Docker, no internet. |
| `npm-ci-in-box.test.ts` | Docker-gated: a real `npm ci` inside a real worker box, against the real registry, reachable only because the project listed it. Skips without Docker; runs for real under `.github/workflows/docker-tests.yml`. |
| `container/doctor-check.ts` | `fabrica doctor`'s `relay image` line - present, or a FAIL carrying the exact `docker pull`. |
| `docker-isolation.test.ts` | The containerized proof: a real worker box, on the isolated network, reaches the relay container and nothing else; the relay container itself reaches the real internet through its own egress network. |
