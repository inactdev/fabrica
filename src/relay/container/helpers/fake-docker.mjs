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
//   config.json - `{ runExitCode?: number, logsOutput?: string }`, both
//                 optional; a missing file means every default below.
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
appendFileSync(join(stateDir, "calls.jsonl"), `${JSON.stringify(args)}\n`);

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
  case "logs":
    // Deliberately never FABRICA-RELAY-LISTENING: this fake exists to
    // drive the paths where the relay never reports itself listening.
    process.stdout.write(config.logsOutput ?? "");
    process.exit(0);
  case "rm":
  case "stop":
    process.exit(0);
  default:
    process.stderr.write(`fake docker: unexpected command ${JSON.stringify(args)}\n`);
    process.exit(1);
}
