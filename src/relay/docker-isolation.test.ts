// The faithful end-to-end proof of issue #186's "the worker box having
// no direct network so all traffic goes through that relay": a real
// container, attached only to a throwaway isolated network, reaching
// the relay listening on that network's gateway address while being
// unable to reach the open internet at all. Skips (never fails) when
// Docker isn't available, matching src/containment/run.test.ts's own
// convention - this needs a real daemon to prove anything.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIsolatedNetwork, removeIsolatedNetwork, runContained } from "../containment/index.ts";
import { startRelay } from "./server.ts";

const IMAGE = "alpine";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("a worker box on the isolated network reaches only the relay, never the open internet directly", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");

  const workdir = mkdtempSync(join(tmpdir(), "fabrica-relay-isolation-workdir-"));
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-relay-isolation-record-"));
  const networkName = `fabrica-test-relay-${process.pid}`;

  const network = await createIsolatedNetwork(networkName);
  const relay = await startRelay({
    recordHome,
    taskId: "t1",
    bindAddress: network.gatewayIp,
    tunnelAllowlist: [{ host: "github.com" }],
  });

  try {
    const reachesRelay = await runContained("nc", ["-z", "-w", "3", network.gatewayIp, String(relay.port)], {
      workdir,
      network: { isolatedNetwork: networkName },
      image: IMAGE,
    });
    assert.equal(reachesRelay.exitCode, 0, "the worker box must be able to reach the relay on the isolated network's gateway address");

    const reachesInternet = await runContained("nc", ["-z", "-w", "3", "1.1.1.1", "443"], {
      workdir,
      network: { isolatedNetwork: networkName },
      image: IMAGE,
    });
    assert.notEqual(reachesInternet.exitCode, 0, "the worker box must not be able to reach the open internet directly");
  } finally {
    await relay.close();
    await removeIsolatedNetwork(networkName);
  }
});
