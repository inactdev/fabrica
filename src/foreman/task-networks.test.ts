// No daemon anywhere near these: helpers/fake-docker.mjs goes on PATH
// as `docker` (src/containment/helpers/install-fake-docker.ts), so the
// sweep's real `execFile("docker", ...)` calls are the ones asserted on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doTask } from "./do.ts";
import { sweepTaskNetworks } from "./task-networks.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { installFakeDocker } from "../containment/helpers/install-fake-docker.ts";
import { TASK_LABEL } from "../containment/index.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { fixtureCheckBox } from "../../contract/helpers/fake-check-box.ts";

/** Everything the sweep wrote to stderr while `fn` ran. */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return written.join("");
}

test("a finished round sweeps its own task's docker networks, and only its own", async (t) => {
  const docker = installFakeDocker(t, {
    networks: [{ Name: "fabrica-worker-someone-else", Labels: { [TASK_LABEL]: "another-task" } }],
  });
  const project = makeFixtureRepo("exit 0", { inspector: false });
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-sweep-home-"));
  const brain = fakeBrain({ onWork: (_brief, workdir) => writeFileSync(join(workdir, "feature.txt"), "work\n") });

  const task = await doTask(recordHome, "small change", { project, brain, checkBox: fixtureCheckBox().box });

  const sweeps = docker
    .calls()
    .filter((call) => call[0] === "network" && call[1] === "ls")
    .map((call) => call.join(" "));
  assert.ok(
    sweeps.includes(`network ls --filter label=${TASK_LABEL}=${task.id} --format {{.Name}}`),
    `the round must sweep its own task's networks, got: ${JSON.stringify(sweeps)}`
  );
  assert.deepEqual(docker.remaining(), ["fabrica-worker-someone-else"], "another task's network is never touched");
});

test("a network that will not go away is reported, with the command that clears it", async (t) => {
  installFakeDocker(t, {
    networks: [{ Name: "fabrica-worker-stuck", Labels: { [TASK_LABEL]: "t1" }, Containers: { abc123: {} } }],
    failDisconnect: true,
  });

  const said = await captureStderr(() => sweepTaskNetworks("t1"));

  assert.match(said, /could not remove this task's docker network fabrica-worker-stuck/);
  assert.match(said, /has active endpoints/, "docker's own reason must be in there");
  assert.match(said, /docker network prune -f/);
});

test("a machine with no docker at all says nothing - there is nothing to sweep", async (t) => {
  installFakeDocker(t, { failLs: true });

  const said = await captureStderr(() => sweepTaskNetworks("t1"));

  assert.equal(said, "");
});
