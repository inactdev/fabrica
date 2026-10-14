// `fabrica up`'s hook into this integration: proves it starts the
// watcher when both HERDR_ENV and HERDR_PANE_ID are set, it never
// starts a second one when one is already running for the same record
// home, it never starts anything at all outside a Herdr pane, and it
// notices - and says so via `notify` - when a watcher that was running
// has since exited, but stays silent on an ordinary first start. All
// use injected deps (no real spawn, no real pid file) -
// herdr-watcher.test.ts covers the real herdrWatcherStatus liveness
// check separately.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeStart } from "./up-hook.ts";

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-herdr-up-hook-"));
}

const INSIDE_HERDR_ENV = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p0" };

test("maybeStart: starts the watcher exactly once, silently, when inside a Herdr pane and nothing has ever run yet", async () => {
  const recordHome = tempRecordHome();
  let spawnCalls: { recordHome: string; entryScript: string; env?: NodeJS.ProcessEnv }[] = [];
  const notices: string[] = [];

  await maybeStart(
    { recordHome, env: INSIDE_HERDR_ENV, notify: (line) => notices.push(line) },
    { status: () => "never-started", spawn: (opts) => spawnCalls.push(opts) }
  );

  assert.equal(spawnCalls.length, 1, "expected exactly one spawn");
  assert.equal(spawnCalls[0].recordHome, recordHome);
  assert.match(spawnCalls[0].entryScript, /herdr-watcher\.ts$/);
  assert.equal(spawnCalls[0].env?.FABRICA_HOME, recordHome);
  assert.deepEqual(notices, [], "an ordinary first start says nothing");
});

test("maybeStart: does not start a second watcher when one is already running for this record home", async () => {
  const recordHome = tempRecordHome();
  let spawnCalls = 0;

  await maybeStart({ recordHome, env: INSIDE_HERDR_ENV }, { status: () => "running", spawn: () => spawnCalls++ });

  assert.equal(spawnCalls, 0, "must not start a second watcher when one is already running");
});

test("maybeStart: notices and says so when a watcher had exited, then starts a fresh one", async () => {
  const recordHome = tempRecordHome();
  let spawnCalls = 0;
  const notices: string[] = [];

  await maybeStart(
    { recordHome, env: INSIDE_HERDR_ENV, notify: (line) => notices.push(line) },
    { status: () => "exited", spawn: () => spawnCalls++ }
  );

  assert.equal(spawnCalls, 1, "an exited watcher should still be restarted");
  assert.equal(notices.length, 1, "exactly one notice should be printed");
  assert.match(notices[0], /exited/);
});

test("maybeStart: called twice in a row only starts the watcher once", async () => {
  const recordHome = tempRecordHome();
  let running = false;
  let spawnCalls = 0;
  const deps = {
    status: () => (running ? ("running" as const) : ("never-started" as const)),
    spawn: () => {
      spawnCalls++;
      running = true; // the real watcher would have written its pid file by now
    },
  };

  await maybeStart({ recordHome, env: INSIDE_HERDR_ENV }, deps);
  await maybeStart({ recordHome, env: INSIDE_HERDR_ENV }, deps);

  assert.equal(spawnCalls, 1, "a second call must not start a second watcher");
});

test("maybeStart: does nothing outside a Herdr pane, even if asked to run twice", async () => {
  const recordHome = tempRecordHome();
  let spawnCalls = 0;
  const deps = { status: () => "never-started" as const, spawn: () => spawnCalls++ };

  await maybeStart({ recordHome, env: {} }, deps);
  await maybeStart({ recordHome, env: { HERDR_ENV: "1" } }, deps); // pane id missing
  await maybeStart({ recordHome, env: { HERDR_PANE_ID: "w1:p0" } }, deps); // env flag missing

  assert.equal(spawnCalls, 0, "must never start outside a Herdr pane");
});
