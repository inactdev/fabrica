#!/usr/bin/env node
// Test-only: a stand-in for the `docker` CLI itself, so launch.ts's
// failure paths can be driven with no Docker daemon anywhere near them.
// There are no containers and no networks here - just a record of every
// call and a scripted answer to each.
//
// A test copies this file onto a throwaway directory as `docker`, marks
// it executable, and puts that directory first on `PATH`. launch.ts's
// own `execFile("docker", ...)` calls then reach this instead of the
// real CLI, with nothing in launch.ts changed to make it testable - the
// argv a test asserts on is the exact argv a real daemon would get.
//
// `FABRICA_FAKE_DOCKER` points at a directory holding:
//   config.json - every field optional; a missing file means every
//                 default below:
//                   runExitCode   - exit code for `docker run`
//                   logsOutput    - what every `docker logs` prints
//                   logsOutputs   - one entry per `docker logs` call, in
//                                   order; the last entry sticks for
//                                   every later call. Lets a test grow
//                                   the relay's log between polls.
//                   logsFailFrom  - 1-based call number from which
//                                   `docker logs` fails the way it does
//                                   for a container docker no longer
//                                   knows (`--rm` reaped it).
//                   inspectOutput - what `docker inspect` prints.
//   calls.jsonl - appended to here, one JSON argv array per call, in
//                 the order the calls arrived.

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const stateDir = process.env.FABRICA_FAKE_DOCKER;
if (!stateDir) {
  // Loud, not silent: a test whose PATH shim is in place but whose env
  // var isn't would otherwise look like docker answering oddly.
  process.stderr.write("fake docker: FABRICA_FAKE_DOCKER is not set\n");
  process.exit(64);
}

let config = {};
try {
  config = JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8"));
} catch {
  // No config file, or an unreadable one: defaults apply.
}

const args = process.argv.slice(2);
const callsFile = join(stateDir, "calls.jsonl");

/** How many calls of this command came before this one. Read back from
 * the same file the test asserts on, so there is no second place
 * recording what happened. */
function priorCalls(command) {
  let lines = [];
  try {
    lines = readFileSync(callsFile, "utf8").split("\n").filter((line) => line.trim() !== "");
  } catch {
    // First call of the run - nothing recorded yet.
  }
  return lines.filter((line) => JSON.parse(line)[0] === command).length;
}

const logsCallNumber = args[0] === "logs" ? priorCalls("logs") + 1 : 0;
appendFileSync(callsFile, `${JSON.stringify(args)}\n`);

switch (args[0]) {
  case "run": {
    const exitCode = config.runExitCode ?? 0;
    if (exitCode !== 0) {
      process.stderr.write("fake docker: run refused\n");
      process.exit(exitCode);
    }
    // A real `docker run -d` prints the new container's id.
    process.stdout.write(`${"c".repeat(64)}\n`);
    process.exit(0);
  }
  case "logs": {
    if (config.logsFailFrom !== undefined && logsCallNumber >= config.logsFailFrom) {
      // What the real CLI does once `--rm` has reaped the container:
      // there is no such name any more.
      process.stderr.write(`Error response from daemon: No such container: ${args[1]}\n`);
      process.exit(1);
    }
    // `logsOutput` on its own is deliberately never
    // FABRICA-RELAY-LISTENING: those tests drive the paths where the
    // relay never reports itself listening. `logsOutputs` is for the
    // ones that need it to come up and then say more.
    const scripted = config.logsOutputs;
    if (Array.isArray(scripted) && scripted.length > 0) {
      process.stdout.write(scripted[Math.min(logsCallNumber - 1, scripted.length - 1)]);
      process.exit(0);
    }
    process.stdout.write(config.logsOutput ?? "");
    process.exit(0);
  }
  case "inspect":
    process.stdout.write(config.inspectOutput ?? "");
    process.exit(0);
  case "rm":
  case "stop":
    process.exit(0);
  default:
    process.stderr.write(`fake docker: unexpected command ${JSON.stringify(args)}\n`);
    process.exit(1);
}
