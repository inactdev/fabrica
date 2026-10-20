# The relay died on a refusal; it must not be able to die at all

## What actually killed it (reproduced, not inferred)

The incident: `network-refused` for `registry.npmjs.org` at 15:48:30,
heartbeats continuing, `task-failed` four minutes later with the
worker's own `API Error: Unable to connect to API
(ConnectionRefused)` - the relay container had stopped listening right
after the refusal.

Reproduced in-process against the real `startRelay` (a fake worker
sending `CONNECT registry.npmjs.org:443`, then resetting the socket the
way a real client does after a refused CONNECT, then an ordinary gateway
request):

```
refusal response: "HTTP/1.1 403 Forbidden"
UNCAUGHT: ECONNRESET read ECONNRESET
```

The cause was **not** the record append the task's brief suspected. In
`server.on("connect", ...)` the refusal path wrote `403` and returned
*before* anything attached an `error` listener to the client socket -
only the allowed path reached `clientSocket.on("error", ...)`. A client
that resets the connection after being refused (npm does) therefore
emits `error` on a socket with no listener, which in Node is an uncaught
exception: the whole relay process exits, and every later request from
that worker gets ECONNREFUSED. Same hole on the 400 (unparseable
CONNECT) and 429 (call-limit) paths.

The suspected append was a second, independent way to die, also
reproduced: a `recordHome` the relay cannot write (`EACCES` on
`mkdirSync`) threw straight out of the same handler, with the same
result. Two different faults, one shape - a throw on a refusal path took
the listener down with it.

## The rule this leaves behind

A relay handler runs on a timer/event callback, not on an awaited path,
so **anything** that throws there kills the process and silently breaks
the worker it serves. Every socket the relay touches gets an `error`
listener before it is written to, both top-level handlers are wrapped,
and the server keeps a permanent `error` listener past `listen()` (the
bind-time one was `once`). Serving never depends on recording: a refusal
that cannot be reported is one line on the relay's own log, dropped.

## The relay no longer knows where the record is

Refusals leave the container on stdout (`FABRICA-RELAY-REFUSAL <json>`,
printed by `container/entrypoint.mjs`, not by `server.mjs` - the server
only calls an `onRefusal` callback) and the host side appends the
`network-refused` event (`container/launch.ts`'s watcher). `RelayOptions`
has no `recordHome`/`taskId` any more and the record home is not
bind-mounted into the relay container at all, so no host file path exists
inside it to fail on - and a compromised relay cannot write the record.

## Only command shapes this repo had already used

The watcher polls one-shot `docker logs <name>` (what `waitForListening`
already does) rather than `docker logs -f`, and detects a dead relay from
that call failing twice in a row - `docker run --rm` reaps an exited
container, so docker stops knowing the name at all, a fact
`waitForListening`'s own comment already relies on. The worker box is
stopped with `docker rm -f` (what `removeContainer` already uses) against
a `--name` the caller supplies. Docker and its documentation were both
unreachable from the box this was written in, so nothing new was invented
on top of what this repo had already verified against a real daemon.
Known limit: a relay container that is stopped but *not* removed still
reads as alive to this watcher.

## A Worker box for this project cannot run `npm test`

Worth knowing before planning any task in this repo: a Worker box only
reaches hosts its project declared (`projects.toml`'s `hosts`), and
Fabrica's own entry does not list `registry.npmjs.org` - which is
exactly the refusal the incident above starts with. A box therefore has
no `node_modules` and cannot install any: `npm install` fails on the
relay's `403`, so `npm test` (which runs `tsc --noEmit` and then `tsx`)
cannot run in there at all.

What does work, and what this task was verified with:

- `node --test <file.test.ts>` - Node 24 strips TypeScript types
  natively, and this project imports with explicit `.ts` extensions, so
  the whole suite runs file by file with no dependencies at all. The only
  files that need more are the ones that spawn `node_modules/.bin/tsx`
  (the record's concurrent-append proofs, `src/line/isolation.test.ts`,
  anything going through `spawn-detached.ts`) and the handful that import
  `smol-toml` (`src/config/load.ts`'s only dependency).
- **Not** `tsc --noEmit`: there is no TypeScript in the box and no way
  to get one. Type errors are invisible from in here, so a task that
  changes types is relying on CI (or the Client) for that check - say so
  in `couldNotVerify` rather than implying a clean typecheck.

Declaring the registry for this project would close all of it. That is
the Client's call, not a task's.

## The alternative that was rejected

The smallest possible fix is one `clientSocket.on("error", ...)` line on
the refusal path, plus a `try`/`catch` around the append. That fixes the
reproduced crash and nothing else, and it was rejected: the append would
still run inside the relay container against a host path, so a record
home that moves, fills up or is mounted read-only is still a relay
failure waiting to happen, and the next handler someone adds to this file
re-opens exactly the same hole. Safety first means the relay cannot be
killed by a refusal *in principle*, not that this one refusal no longer
kills it - hence the callback boundary, the host-side append, and the
blanket handler wrapping.

Also rejected: restarting a dead relay (offered in the brief's
clarification as an alternative to failing fast). A replacement container
gets a new address on the isolated network while the worker's
`ANTHROPIC_BASE_URL`/`HTTP_PROXY` still name the old one, so the restart
would have to be invisible to a worker that cannot be reconfigured
mid-run - more machinery, for a case that should now be unreachable.

## A relay that is gone fails the attempt in one heartbeat, not four minutes

`withHeartbeat` (src/foreman/attempts.ts) takes an optional `probe`
alongside its tick. `runAttempts` passes one that reads
`src/brain/relay-health.ts` - a module-level registry keyed on `workdir`,
the same mechanism and the same reasoning as
`src/brain/live-transcript.ts`, so nothing is added to `Brain`'s ratified
signature. The adapter registers the probe while its worker box runs; a
reported problem stops the heartbeat (a known-dead worker must not keep
reporting "still going"), force-removes the worker box so `work()`
returns at once with its teardown intact, and fails the attempt with a
message naming the relay. The grace window exists only so a brain that
ignores the abort cannot reproduce the four minutes of silence.
