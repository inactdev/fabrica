// The real proof, against the real Docker daemon - skips (never fails)
// when Docker isn't available, matching run.test.ts's own convention,
// since this module needs a real daemon to prove anything.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createIsolatedNetwork, removeIsolatedNetwork } from "./isolated-network.ts";
import { ContainmentError } from "./errors.ts";
import { installFakeDocker } from "./helpers/install-fake-docker.ts";
import { NETWORK_PRUNE_COMMAND } from "./network-pools.ts";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("createIsolatedNetwork creates an internal network; removeIsolatedNetwork cleans it up", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const name = `fabrica-test-isolated-${process.pid}`;

  const network = await createIsolatedNetwork(name);
  try {
    assert.equal(network.name, name);

    const inspected = execFileSync("docker", ["network", "inspect", name, "--format", "{{.Internal}}"]).toString().trim();
    assert.equal(inspected, "true", "the network must be created with --internal");
  } finally {
    await removeIsolatedNetwork(name);
  }

  assert.throws(
    () => execFileSync("docker", ["network", "inspect", name], { stdio: "ignore" }),
    "removeIsolatedNetwork must actually remove the network"
  );
});

test("removeIsolatedNetwork on a network that never existed is success, not a failure", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");

  // Removing it twice over, for the shape a round's teardown actually
  // meets: the Foreman's end-of-round sweep removed it already.
  const name = `fabrica-test-idempotent-${process.pid}`;
  await createIsolatedNetwork(name);
  await removeIsolatedNetwork(name);
  await removeIsolatedNetwork(name);

  await removeIsolatedNetwork(`fabrica-test-never-existed-${process.pid}`);
});

// The tests below need no daemon at all - helpers/fake-docker.mjs goes
// on PATH as `docker` instead - so they run everywhere and never skip,
// unlike the daemon-dependent ones above.

test("the network carries its task's label, so a later sweep can find it", async (t) => {
  const docker = installFakeDocker(t, {});

  await createIsolatedNetwork("fabrica-worker-abc", { taskId: "20261025-some-task-x1" });

  assert.deepEqual(docker.calls()[0], [
    "network",
    "create",
    "--internal",
    "--driver",
    "bridge",
    "--label",
    "fabrica.role=worker",
    "--label",
    "fabrica.task=20261025-some-task-x1",
    "fabrica-worker-abc",
  ]);
});

test("a network docker no longer has is removed successfully, with no force flag used to get there", async (t) => {
  const docker = installFakeDocker(t, { networks: [] });

  // No rejection: the state this asks for is already true. A round's
  // teardown runs in a `finally`, where a throw would replace the
  // round's own result with a plumbing error.
  await removeIsolatedNetwork("fabrica-worker-already-swept");

  assert.deepEqual(
    docker.calls(),
    [["network", "rm", "fabrica-worker-already-swept"]],
    "the argv must stay the plain removal - the tolerance is in reading docker's answer, not in a flag"
  );
});

test("a network that is still there and will not go is still a loud failure", async (t) => {
  installFakeDocker(t, {
    networks: [{ Name: "fabrica-worker-held", Containers: { abc123: {} } }],
  });

  await assert.rejects(
    removeIsolatedNetwork("fabrica-worker-held"),
    (err: unknown) =>
      err instanceof ContainmentError &&
      err.code === "network-remove-failed" &&
      err.message.includes("has active endpoints")
  );
});

test("exhausted address pools are reported as that, with the prune command", async (t) => {
  // moby's own wording (daemon/libnetwork/ipamapi/contract.go's
  // ErrNoMoreSubnets) - see network-pools.ts.
  installFakeDocker(t, { createFailure: "all predefined address pools have been fully subnetted" });

  await assert.rejects(
    createIsolatedNetwork("fabrica-worker-abc", { taskId: "t1" }),
    (err: unknown) =>
      err instanceof ContainmentError &&
      err.code === "network-create-failed" &&
      /no address pool left/.test(err.message) &&
      err.message.includes(NETWORK_PRUNE_COMMAND) &&
      err.message.includes("all predefined address pools have been fully subnetted")
  );
});
