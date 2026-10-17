// The failure-path proof for startContainerizedRelay: every way it can
// throw once `docker run` has been attempted must leave no container
// behind, because a container still attached to the isolated network
// makes that network's own removal (the caller's teardown - see
// src/brain/adapters/'s reference adapter) fail too - exactly what left
// a `fabrica-relay-<id>` container and three `fabrica-worker-<id>` /
// `fabrica-relay-egress-<id>` networks behind on the Client's machine
// after the 2026-10-17 proof runs.
//
// Runs everywhere, Docker or not, and never touches a real daemon:
// helpers/fake-docker.mjs goes on PATH as `docker` instead (see that
// file). So, unlike this module's daemon-dependent tests, there is
// nothing here to skip.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RelayError } from "../errors.mjs";
import { startContainerizedRelay } from "./launch.ts";

const FAKE_DOCKER = join(dirname(fileURLToPath(import.meta.url)), "helpers", "fake-docker.mjs");

interface FakeDockerConfig {
  runExitCode?: number;
  logsOutput?: string;
}

interface FakeDocker {
  recordHome: string;
  /** Every `docker` call made, argv only, in arrival order. */
  calls: () => string[][];
}

function fakeDocker(t: TestContext, config: FakeDockerConfig): FakeDocker {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "fabrica-relay-launch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const bin = join(root, "bin");
  const state = join(root, "state");
  const recordHome = join(root, "record");
  for (const dir of [bin, state, recordHome]) mkdirSync(dir);
  writeFileSync(join(state, "config.json"), JSON.stringify(config));

  const shim = join(bin, "docker");
  copyFileSync(FAKE_DOCKER, shim);
  chmodSync(shim, 0o755);

  // `dirname(process.execPath)` too, so the shim's own `#!/usr/bin/env
  // node` resolves to the very runtime running this test rather than
  // depending on `node` already being on the ambient PATH.
  const priorPath = process.env.PATH;
  const priorState = process.env.FABRICA_FAKE_DOCKER;
  process.env.PATH = [bin, dirname(process.execPath), priorPath ?? ""].join(delimiter);
  process.env.FABRICA_FAKE_DOCKER = state;
  t.after(() => {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    if (priorState === undefined) delete process.env.FABRICA_FAKE_DOCKER;
    else process.env.FABRICA_FAKE_DOCKER = priorState;
  });

  const callsFile = join(state, "calls.jsonl");
  return {
    recordHome,
    calls: () =>
      existsSync(callsFile)
        ? readFileSync(callsFile, "utf8")
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line) => JSON.parse(line) as string[])
        : [],
  };
}

/** The network names are deliberately ones no real daemon could have:
 * if the PATH shim above ever failed to take effect, the assertions
 * below fail loudly on a real `docker run` that refused, rather than
 * quietly starting a real relay container somewhere. */
function launchOptions(recordHome: string) {
  return {
    recordHome,
    taskId: "t1",
    isolatedNetwork: `fabrica-test-no-such-network-iso-${process.pid}`,
    egressNetwork: `fabrica-test-no-such-network-egress-${process.pid}`,
    tunnelAllowlist: [],
    listenTimeoutMs: 100,
  };
}

/** The `--name` launch.ts generated for this run, read back out of the
 * `docker run` it actually issued - the caller never sees it otherwise
 * when the launch fails. */
function containerNameFrom(calls: string[][]): string {
  const run = calls.find((call) => call[0] === "run");
  assert.ok(run, "expected a `docker run` call");
  const name = run[run.indexOf("--name") + 1];
  assert.match(name, /^fabrica-relay-[0-9a-f]{32}$/);
  return name;
}

test("a relay container that never reports listening is removed before listen-failed is thrown", async (t) => {
  const docker = fakeDocker(t, { logsOutput: "relay died: listen EADDRINUSE\n" });

  await assert.rejects(
    startContainerizedRelay(launchOptions(docker.recordHome)),
    (err: unknown) => {
      assert.ok(err instanceof RelayError, `expected a RelayError, got ${String(err)}`);
      assert.equal(err.code, "listen-failed");
      // The container's own output still has to reach the Client, even
      // though the container holding it is gone a moment later.
      assert.match(err.message, /relay died: listen EADDRINUSE/);
      return true;
    }
  );

  const calls = docker.calls();
  const name = containerNameFrom(calls);
  const removal = calls.findIndex((call) => call[0] === "rm");
  assert.notEqual(removal, -1, "the relay container must be removed, not left behind");
  assert.deepEqual(calls[removal], ["rm", "-f", name], "removal must force-remove the container this run started");
  assert.equal(removal, calls.length - 1, "removal must be the last thing this launch does");

  const lastLogsRead = calls.map((call) => call[0]).lastIndexOf("logs");
  assert.ok(lastLogsRead !== -1 && lastLogsRead < removal, "the relay's logs must be read before it is removed");
});

test("a `docker run` that fails leaves no container behind either", async (t) => {
  const docker = fakeDocker(t, { runExitCode: 125 });

  await assert.rejects(
    startContainerizedRelay(launchOptions(docker.recordHome)),
    (err: unknown) => {
      assert.ok(err instanceof RelayError, `expected a RelayError, got ${String(err)}`);
      assert.equal(err.code, "listen-failed");
      assert.match(err.message, /could not start the relay container/);
      return true;
    }
  );

  // `docker run` creates the container before it starts it, so a failure
  // here can still have left one named for this run - removed like any
  // other pre-listening failure, with no attempt to wait for a container
  // that was never confirmed started.
  const calls = docker.calls();
  assert.deepEqual(
    calls.map((call) => call[0]),
    ["run", "rm"]
  );
  assert.deepEqual(calls[1], ["rm", "-f", containerNameFrom(calls)]);
});
