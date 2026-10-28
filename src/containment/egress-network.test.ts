// The real proof, against the real Docker daemon - skips (never fails)
// when Docker isn't available, matching isolated-network.test.ts's own
// convention.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createEgressNetwork, removeEgressNetwork } from "./egress-network.ts";
import { ContainmentError } from "./errors.ts";
import { installFakeDocker } from "./helpers/install-fake-docker.ts";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("createEgressNetwork creates a plain (non-internal) network; removeEgressNetwork cleans it up", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const name = `fabrica-test-egress-${process.pid}`;

  const network = await createEgressNetwork(name);
  try {
    assert.equal(network.name, name);

    const inspected = execFileSync("docker", ["network", "inspect", name, "--format", "{{.Internal}}"]).toString().trim();
    assert.equal(inspected, "false", "an egress network must not be created with --internal");
  } finally {
    await removeEgressNetwork(name);
  }

  assert.throws(
    () => execFileSync("docker", ["network", "inspect", name], { stdio: "ignore" }),
    "removeEgressNetwork must actually remove the network"
  );
});

test("removeEgressNetwork on a network that never existed is success, not a failure", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");

  const name = `fabrica-test-egress-idempotent-${process.pid}`;
  await createEgressNetwork(name);
  await removeEgressNetwork(name);
  await removeEgressNetwork(name);

  await removeEgressNetwork(`fabrica-test-never-existed-${process.pid}`);
});

// Needs no daemon at all - helpers/fake-docker.mjs goes on PATH as
// `docker` instead - so these two run everywhere and never skip.

test("a network docker no longer has is removed successfully, with no force flag used to get there", async (t) => {
  const docker = installFakeDocker(t, { networks: [] });

  await removeEgressNetwork("fabrica-relay-egress-already-swept");

  assert.deepEqual(
    docker.calls(),
    [["network", "rm", "fabrica-relay-egress-already-swept"]],
    "the argv must stay the plain removal - the tolerance is in reading docker's answer, not in a flag"
  );
});

test("a network that is still there and will not go is still a loud failure", async (t) => {
  installFakeDocker(t, {
    networks: [{ Name: "fabrica-relay-egress-held", Containers: { abc123: {} } }],
  });

  await assert.rejects(
    removeEgressNetwork("fabrica-relay-egress-held"),
    (err: unknown) =>
      err instanceof ContainmentError &&
      err.code === "network-remove-failed" &&
      err.message.includes("has active endpoints")
  );
});
