// Proves findLiveViewProcess/stopLiveViewProcess against real child
// processes - a pid file or a process table scan is only trustworthy
// if it's actually checked against reality, not assumed to behave a
// particular way.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLiveViewProcess, LIVE_VIEW_COMMAND_MARKER, stopLiveViewProcess, writeLiveViewPidFile } from "./live-view-process.ts";

function makeRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-live-view-process-"));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

/** A real process whose command line contains LIVE_VIEW_COMMAND_MARKER,
 * the same way the real live view's own invocation (via tsx-bootstrap)
 * always does - without actually running the real server or binding
 * any port. */
function spawnFakeLiveView(): ReturnType<typeof spawn> {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", LIVE_VIEW_COMMAND_MARKER], { stdio: "ignore" });
}

/** A real process whose command line does NOT contain the marker -
 * stands in for "some unrelated process happens to be running". */
function spawnUnrelatedProcess(): ReturnType<typeof spawn> {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
}

test("findLiveViewProcess: finds it via the record home's own pid file, verified against its real command line", async () => {
  const recordHome = makeRecordHome();
  const child = spawnFakeLiveView();
  try {
    assert.ok(typeof child.pid === "number");
    writeFileSync(join(recordHome, "live-view.pid"), String(child.pid), "utf8");

    const found = findLiveViewProcess(recordHome);
    assert.deepEqual(found, { pid: child.pid });
  } finally {
    child.kill("SIGKILL");
  }
});

test("findLiveViewProcess: a pid file naming a dead process is treated as stale, and removed", async () => {
  const recordHome = makeRecordHome();
  const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const deadPid = dead.pid;
  assert.ok(typeof deadPid === "number" && deadPid > 0);

  const pidFile = join(recordHome, "live-view.pid");
  writeFileSync(pidFile, String(deadPid), "utf8");

  assert.equal(findLiveViewProcess(recordHome), null);
  assert.equal(existsSync(pidFile), false, "a stale pid file should be cleaned up");
});

test("findLiveViewProcess: a pid file naming a real, alive but unrelated process is never trusted - its command line doesn't match", async () => {
  const recordHome = makeRecordHome();
  const unrelated = spawnUnrelatedProcess();
  try {
    writeFileSync(join(recordHome, "live-view.pid"), String(unrelated.pid), "utf8");

    // No real live view anywhere else either, so this must find nothing
    // at all - never falling back to trusting the pid file just
    // because the process it names happens to be alive.
    assert.equal(findLiveViewProcess(recordHome), null);
  } finally {
    unrelated.kill("SIGKILL");
  }
});

test("findLiveViewProcess: with no pid file for this record home, falls back to a command-line scan and still finds a live view started under a different one", async () => {
  const recordHome = makeRecordHome(); // deliberately: no live-view.pid written here at all
  const child = spawnFakeLiveView();
  try {
    const found = findLiveViewProcess(recordHome);
    assert.deepEqual(found, { pid: child.pid });
  } finally {
    child.kill("SIGKILL");
  }
});

test("findLiveViewProcess: finds nothing, touches nothing, when no pid file and no matching process exist", () => {
  const recordHome = makeRecordHome();
  assert.equal(findLiveViewProcess(recordHome), null);
});

test("stopLiveViewProcess: sends SIGTERM to exactly the pid it's given, and the real process exits", async () => {
  const child = spawnFakeLiveView();
  assert.ok(typeof child.pid === "number");

  stopLiveViewProcess(child.pid!);

  const exited = await waitUntil(() => !isAlive(child.pid!));
  assert.ok(exited, "the process should have exited after SIGTERM");
});

test("writeLiveViewPidFile: writes this process's own pid", () => {
  const recordHome = makeRecordHome();
  writeLiveViewPidFile(recordHome);

  const written = readFileSync(join(recordHome, "live-view.pid"), "utf8").trim();
  assert.equal(Number(written), process.pid);
});
