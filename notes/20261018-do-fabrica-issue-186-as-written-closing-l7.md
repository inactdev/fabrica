# Issue #186, second half: per-project allowed hosts, relay limits, doctor, npm ci

## The plan, and the alternatives rejected before starting

The job has four moving parts that all need the same thing first: a way
for *per-task* facts (which record to write a refusal to, which hosts
this project declared, which limits apply) to reach
`src/brain/adapters/claude-code.ts`'s `connectThroughRelay`, which is
behind the `Brain` interface and receives only `brief`/`workdir`/`opts`.

Three ways were weighed, safest first:

1. **A new field on `BrainWorkOptions` / `contract/surface.ts`.**
   Rejected: the contract is the ratified answer key and `Brain` is rule
   8's socket - widening it to carry Fabrica's own plumbing is both a
   protected-path change and a promise to every future adapter that it
   must understand relay policy. It also does nothing for `ask()`, whose
   signature is `ask(brief)` and nothing else, on purpose (rule 1 holds
   there by construction).
2. **A module-level registry keyed by `workdir`**, exactly as
   `src/brain/live-transcript.ts` does for live transcript entries.
   Rejected, though it is the closest existing precedent: `ask()` has no
   `workdir` at all - it runs before any ProductionLine exists - so the
   clarifying call, which is a real model call over the real relay,
   would be left outside the mechanism; and a registry needs an explicit
   unregister on every path or a later task inherits a stale entry.
3. **`AsyncLocalStorage` (`src/brain/task-network.ts`)** - chosen. The
   Foreman wraps each `brain.ask`/`brain.work` call in
   `withTaskNetwork(policy, ...)`; the adapter reads
   `currentTaskNetwork()`. It covers both calls with one mechanism,
   needs no key that both sides must agree on, cannot leak past the call
   it wraps (the scope ends when the callback settles), and stays
   correct with several tasks running concurrently in one process -
   which is the property the workdir keying existed to protect.

The other decisions, for the record:

- **Where the project's declaration is read.** `src/foreman/
  network-policy.ts`, mirroring `resolve-check.ts` ("the one place
  src/config actually participates in the loop") including its
  realpath-both-sides path matching. The alternative - passing a policy
  down through `createForeman`'s options - would have meant widening
  `contract/surface.ts`'s Foreman options, i.e. alternative 1 again.
- **Composing the allowlist.** `src/relay/policy.ts` composes
  *base hosts + declared hosts* and never knows what the base hosts are;
  the adapter supplies the model host, since CONTRACT rule 8 forbids
  naming it anywhere else. GitHub stays in `src/relay/allowlist.mjs`
  because GitHub is a destination, not a brain.
- **Where the limits are enforced.** Inside `server.mjs`, the relay
  itself, not the adapter: an adapter could forget, and the relay is the
  only thing on the path that a worker cannot route around.

## sandbox-runtime was tried first, and rejected

Recorded here because this is the first file in the repository allowed
to name it: `src/relay/README.md` cannot, since CONTRACT rule 8's scan
(`contract/rule8.no-favorite-brain.test.ts`) reads every file under
`src/`, prose included, and flags a model vendor's name wherever it
appears outside `src/brain/adapters/`.

The tool is **`@anthropic-ai/sandbox-runtime`** (Anthropic's OS-level
sandboxing CLI and library, which also ships a standalone network-proxy
mode). It was evaluated first, as the issue instructed, by reading its
current documentation - no Docker daemon was reachable to install and
run it. On paper it is a close match: a proxy deployable independently
of its own sandboxing, domain allowlisting with named denial reasons,
and credential masking that swaps a sentinel value for a real one.

It was rejected for four reasons, which `src/relay/README.md` states in
full under "Why not the third-party sandboxing/proxy tool the issue
named" (in deliberately unnamed terms):

1. **Its credential masking requires TLS termination** inside the
   worker's container, and a MITM certificate the worker must trust.
   `src/relay/`'s gateway mode gets the same swap with no TLS
   termination anywhere, because the credential-bearing leg is never
   tunnelled end-to-end in the first place.
2. **It is the dependencies question one round early** - adopting it
   adds a package to `package.json`, which that round was told to leave
   to the second half. Node's own `http`/`https`/`net` needed no such
   decision.
3. **Its package name fails rule 8's own scan.** The scan flags an
   import specifier like any other text, so importing it from a
   brain-agnostic module - which `src/relay/` must be - fails the
   contract test by construction, not by an oversight a comment fixes.
4. **Its sandboxing model doesn't match this one.** Its isolation is
   OS-level (bubblewrap / sandbox-exec) with the proxy wired in over
   inherited file descriptors; Fabrica's worker boxes are Docker
   containers (`src/containment/`, issue #44), so there is no native
   process for it to sandbox and its FD-passing contract would have to
   be retrofitted onto a Docker network boundary.

None of this is a verdict on the tool in general. It is a real project
solving a closely related problem; it just does not fit this codebase
without first answering questions that belong to later issues.

## What the second half added, and the sharp edges in it

- **`projects.toml` gained three per-project keys** - `hosts`,
  `maxRequestBytes`, `maxCallsPerTask` (`src/config/load.ts`). `hosts`
  is **additive**: the model host and GitHub are always allowed, and a
  project's own entries are added to them, never a replacement for them
  (Client ruling, issue #186 clarification). An entry may name a port
  (`"example.com:8443"`); without one it matches any port.
- **A refusal now lands on the task's own record.** It used to go to a
  throwaway scratch directory, because the adapter had no task id - the
  `AsyncLocalStorage` context above is what fixed that. The scratch
  fallback is still there for a caller with no context (a library-level
  call, this module's own tests).
- **Two limits the relay enforces itself**: 10 MB per request and 2000
  calls per task by default. A request over either is refused on its
  own - 413 or 429, and a `network-refused` event naming which limit -
  and the task keeps running; rule 10's spending cap stays the only
  thing that stops a task (Client ruling).
- **The request-size limit is gateway-mode only, inherently.** A
  `CONNECT` tunnel is raw bytes the relay deliberately cannot read, so
  there is no "request" in it to measure. The per-task call limit counts
  both shapes, since both are one call each.
- **The call-limit refusal is recorded once per task, not once per
  refused call.** `events.jsonl` is global to a record home and is
  re-read whole by `fabrica status`/`watch`; a worker looping against an
  exhausted limit would otherwise write an unbounded number of
  identical lines and make every other task's status slower. The second
  and later refusals still happen - they just add no new information to
  the record. A refused *host* is still recorded every time: each one
  can name a different host.
- **`fabrica doctor` gained two lines.** "relay image" FAILs when the
  digest-pinned stock Node image the relay container runs from is not
  pulled (fix: the exact `docker pull`). "worker CLI" reports the
  version actually installed inside the worker image against the version
  the Dockerfile pins, and FAILs only when a pin exists and the two
  differ - a missing pin, or an image that cannot be queried, is
  reported but never a failure (the "worker image" line above it
  already owns that failure).
- **npm's proxy behaviour was read from the installed npm itself**
  (11.16.0) rather than guessed: `@npmcli/config`'s own `https-proxy`
  definition documents that `HTTPS_PROXY`/`https_proxy`/`HTTP_PROXY`/
  `http_proxy` are honored, and `@npmcli/agent/lib/proxy.js` shows an
  `https:` registry URL resolving its proxy from `https_proxy` (env keys
  lowercased) and reaching it through `HttpsProxyAgent`, i.e. `CONNECT`
  - which is why a listed registry host has to be on the *tunnel*
  allowlist, not the gateway.
