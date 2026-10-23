// The macOS "Docker is installed but not running" step `fabrica up`
// runs before it asks doctor anything (Client ruling 2026-10-23). Every
// case is driven through injected seams - no test here spawns `open`,
// `docker`, or anything else, and the platform is injected too, so the
// macOS-only paths are exercised on the Linux this suite runs on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DOCKER_START_TIMEOUT_MS, ensureDockerDaemon } from "./docker-daemon.ts";

function capture() {
  const notices: string[] = [];
  const warnings: string[] = [];
  return { notices, warnings, notify: (l: string) => notices.push(l), warn: (l: string) => warnings.push(l) };
}

/** A daemon that answers only after `after` polls - how a real Docker
 * Desktop behaves: down when asked, up some seconds later. */
function daemonUpAfter(after: number): () => boolean {
  let asked = 0;
  return () => (asked++ >= after);
}

const neverStarted = () => {
  throw new Error("must not try to start Docker");
};

test("ensureDockerDaemon: nothing is spawned or printed on a platform this cannot start Docker on", async () => {
  const io = capture();
  const outcome = await ensureDockerDaemon({
    platform: "linux",
    daemonUp: () => {
      throw new Error("must not even ask whether the daemon is up - this is not a Mac");
    },
    startDockerApp: neverStarted,
    ...io,
  });

  assert.deepEqual(outcome, { status: "not-macos" });
  assert.deepEqual(io.notices, [], "must print nothing at all");
  assert.deepEqual(io.warnings, []);
});

test("ensureDockerDaemon: a daemon that already answers is left alone, silently", async () => {
  const io = capture();
  const outcome = await ensureDockerDaemon({
    platform: "darwin",
    daemonUp: () => true,
    startDockerApp: neverStarted,
    ...io,
  });

  assert.deepEqual(outcome, { status: "already-running" });
  assert.deepEqual(io.notices, [], "a Mac with Docker already running must look exactly like before");
  assert.deepEqual(io.warnings, []);
});

test("ensureDockerDaemon: Docker down on a Mac is started, waited for, and reported", async () => {
  const io = capture();
  let startCalls = 0;

  const outcome = await ensureDockerDaemon({
    platform: "darwin",
    daemonUp: daemonUpAfter(3),
    startDockerApp: () => {
      startCalls += 1;
      return { ok: true, detail: "" };
    },
    timeoutMs: 5_000,
    pollIntervalMs: 1,
    ...io,
  });

  assert.deepEqual(outcome, { status: "started" });
  assert.equal(startCalls, 1, "Docker must be started exactly once");
  assert.match(io.notices[0], /not running - starting it with `open -a Docker`/);
  assert.match(io.notices[0], /waiting up to 5s for the daemon/, "must say what it is waiting on, and for how long");
  assert.match(io.notices.at(-1) ?? "", /daemon is up/);
  assert.deepEqual(io.warnings, []);
});

test("ensureDockerDaemon: a Docker that cannot be started reports the command's own words, never a guess", async () => {
  const io = capture();
  const outcome = await ensureDockerDaemon({
    platform: "darwin",
    daemonUp: () => false,
    startDockerApp: () => ({ ok: false, detail: "Unable to find application named 'Docker'" }),
    timeoutMs: 5_000,
    pollIntervalMs: 1,
    ...io,
  });

  assert.deepEqual(outcome, { status: "start-failed", detail: "Unable to find application named 'Docker'" });
  assert.match(io.warnings.join("\n"), /could not start Docker/);
  assert.match(io.warnings.join("\n"), /Unable to find application named 'Docker'/);
});

test("ensureDockerDaemon: a daemon that never answers gives up at the timeout instead of waiting forever", async () => {
  const io = capture();
  const began = Date.now();

  const outcome = await ensureDockerDaemon({
    platform: "darwin",
    daemonUp: () => false,
    startDockerApp: () => ({ ok: true, detail: "" }),
    timeoutMs: 120,
    pollIntervalMs: 1,
    ...io,
  });

  assert.deepEqual(outcome, { status: "timed-out" });
  assert.ok(Date.now() - began < 5_000, "must stop at its own timeout, not keep polling");
  assert.match(io.warnings.join("\n"), /still wasn't answering/);
});

test("ensureDockerDaemon: says what it is waiting on while it waits, not only once at the end", async () => {
  const io = capture();
  await ensureDockerDaemon({
    platform: "darwin",
    daemonUp: () => false,
    startDockerApp: () => ({ ok: true, detail: "" }),
    timeoutMs: 1_000,
    pollIntervalMs: 1,
    progressIntervalMs: 100,
    ...io,
  });

  const progress = io.notices.filter((line) => /still waiting on the Docker daemon/.test(line));
  assert.ok(progress.length >= 2, `expected repeated progress lines, got ${JSON.stringify(io.notices)}`);
  assert.match(progress[0], /\d+s of 1s/, "each progress line names the elapsed time against the ceiling");
});

test("ensureDockerDaemon: the documented ceiling is the two minutes the ruling asks for", async () => {
  assert.equal(DOCKER_START_TIMEOUT_MS, 120_000);
});
