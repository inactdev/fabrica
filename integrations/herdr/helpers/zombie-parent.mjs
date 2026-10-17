// Test-only: makes one real, stable zombie process for
// herdr-watcher.test.ts's liveness test, and keeps it a zombie until
// this process is killed.
//
// Why a separate script rather than a few lines inside the test: a
// zombie only exists while its own parent hasn't reaped it, and Node
// reaps a spawned child as soon as its event loop iterates (libuv's
// SIGCHLD handler only writes to a pipe; the waitpid itself happens on
// the next loop turn). The test process has to keep polling, so it can
// never be that parent. This script can: it spawns a child that exits
// immediately, then blocks its own event loop forever, so the exit
// status is never collected - exactly the shape `fabrica up` itself
// produces, spawning the watcher detached and then blocking in the
// foreground harness.
//
// Usage: node zombie-parent.mjs <pid-file>
//   Writes the zombie child's pid to <pid-file> (synchronously - a
//   piped stdout write is documented as asynchronous on macOS, and
//   nothing asynchronous can complete after the block below), then
//   blocks. Kill this process to clean up: the zombie is reparented to
//   init and reaped.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const pidFile = process.argv[2];
if (pidFile === undefined) {
  console.error("usage: node zombie-parent.mjs <pid-file>");
  process.exit(2);
}

const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
writeFileSync(pidFile, String(child.pid), "utf8");

// Blocks the event loop indefinitely without burning CPU - no timer, no
// I/O, nothing that could let libuv reap the child.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
