#!/usr/bin/env node
// Test-only: a stand-in for just the three `docker` commands run.ts
// uses to start and stop a contained run - `run`, `rm -f` and `stop` -
// so the reissued stop (issue #346) can be proven with no Docker
// daemon anywhere near it. Deliberately a second shim rather than a
// case added to helpers/fake-docker.mjs: that one stands for the
// network and image commands and six suites read it, while this one
// models a single container's lifetime and nothing else.
//
// Same mechanism as that fake (see
// notes/20261017-fix-the-relay-s-failure-path-cleanup-in-ph.md,
// "Faking the `docker` CLI: copy a shim onto PATH as `docker`"): a test
// copies this file onto a throwaway directory as `docker`, marks it
// executable and puts that directory first on PATH, so the production
// code's own `spawn("docker", ...)`/`execFile("docker", ...)` reach it
// with no seam added for testability, and the argv asserted on is the
// exact argv a real daemon would have received.
//
// `FABRICA_FAKE_DOCKER_STOP` points at a directory holding:
//   config.json - { missedStops, missedStopReply, runCeilingMs }.
//                 `missedStops` is how many stop calls answer as one
//                 for a container that isn't there before one lands,
//                 standing in for the window where `docker run` has
//                 not created the container yet - the whole bug.
//                 `missedStopReply` is how those answer, and exists
//                 because the real CLI has no single answer here: a
//                 `docker stop` for a container that isn't there fails
//                 and names it ("no-such-container"), while a
//                 force-remove has in some versions treated it as
//                 already done and simply succeeded
//                 ("silent-success"). run.ts reads neither the exit
//                 code nor the message of a stop - every one is
//                 swallowed - so this is not here to pin a docker
//                 version down; it is here so both shapes are driven
//                 through the real production code, and a reissue
//                 that stopped at the first success could not pass
//                 the silent one. `runCeilingMs` is how long a `run`
//                 waits to be stopped before giving up and reporting
//                 that it ran its course (exit 99), which is what a
//                 test asserting on the stop reads as "the stop never
//                 arrived". The 137 and 99 a `run` exits with are this
//                 fake's own, chosen to be told apart; the only exit
//                 code the production code under test actually reads
//                 is the one its own `docker run` client leaves with.
//   stopped     - written by the stop that lands; `run` exits once it
//                 appears, the way a real client exits once its
//                 container is gone.
//   stops       - how many stop calls have arrived so far.
//   calls.jsonl - one JSON argv array per call, in arrival order.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const stateDir = process.env.FABRICA_FAKE_DOCKER_STOP;
if (!stateDir) {
  // Loud, not silent: a test whose PATH shim is in place but whose env
  // var isn't would otherwise look like docker answering oddly.
  process.stderr.write("fake docker (stop): FABRICA_FAKE_DOCKER_STOP is not set\n");
  process.exit(64);
}

const config = JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8"));
const stoppedPath = join(stateDir, "stopped");
const stopsPath = join(stateDir, "stops");

const args = process.argv.slice(2);
appendFileSync(join(stateDir, "calls.jsonl"), `${JSON.stringify(args)}\n`);

/** Blocks this process, the way a real attached `docker run` client
 * blocks on its container - no timers, so nothing here can finish
 * early because the event loop happened to be free. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function containerName() {
  const at = args.indexOf("--name");
  return at === -1 ? undefined : args[at + 1];
}

if (args[0] === "run") {
  const name = containerName();
  if (name === undefined) {
    process.stderr.write("fake docker (stop): run without --name\n");
    process.exit(64);
  }
  const ceilingMs = config.runCeilingMs ?? 20_000;
  const until = Date.now() + ceilingMs;
  while (Date.now() < until) {
    if (existsSync(stoppedPath)) process.exit(137); // SIGKILLed, like a force-removed container
    sleepSync(25);
  }
  // The command ran its full course - exactly the bug this fake exists
  // to be able to fail on, rather than a test hanging for ten minutes.
  process.stderr.write("fake docker (stop): nothing ever stopped this container\n");
  process.exit(99);
}

if (args[0] === "stop" || (args[0] === "rm" && args.includes("-f"))) {
  const arrived = (existsSync(stopsPath) ? Number(readFileSync(stopsPath, "utf8")) : 0) + 1;
  writeFileSync(stopsPath, String(arrived));
  if (arrived <= (config.missedStops ?? 0)) {
    // An answer for a container that isn't there - which is what a stop
    // issued before `docker run` created it gets. Either shape the real
    // CLI has been seen to give; see `missedStopReply` above for why
    // both exist and why neither is load-bearing.
    if ((config.missedStopReply ?? "no-such-container") === "silent-success") process.exit(0);
    process.stderr.write(`Error response from daemon: No such container: ${args[args.length - 1]}\n`);
    process.exit(1);
  }
  writeFileSync(stoppedPath, "");
  process.exit(0);
}

process.stderr.write(`fake docker (stop): unexpected command ${JSON.stringify(args)}\n`);
process.exit(1);
