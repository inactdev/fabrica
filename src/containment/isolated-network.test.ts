// The real proof, against the real Docker daemon - skips (never fails)
// when Docker isn't available, matching run.test.ts's own convention,
// since this module needs a real daemon to prove anything.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createIsolatedNetwork, removeIsolatedNetwork } from "./isolated-network.ts";
import { ContainmentError } from "./errors.ts";

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

test("removeIsolatedNetwork on a network that never existed throws ContainmentError, not a raw docker error", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");

  await assert.rejects(
    removeIsolatedNetwork(`fabrica-test-never-existed-${process.pid}`),
    (err: unknown) => err instanceof ContainmentError && err.code === "network-remove-failed"
  );
});
