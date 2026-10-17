// The faithful end-to-end proof of issue #186's "the worker box having
// no direct network so all traffic goes through that relay": a real
// container, attached only to a throwaway isolated network, reaching
// the relay - itself a container, on the same network, with its own
// separate egress network - while being unable to reach the open
// internet at all. Skips (never fails) when Docker isn't available,
// matching src/containment/run.test.ts's own convention - this needs a
// real daemon to prove anything, and genuinely runs, rather than skips,
// wherever Docker actually is (the Client's own Mac being the point:
// see src/relay/README.md's "Why the relay is the container with two
// networks" for the fact this design fixes that the old host-process
// design didn't).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEgressNetwork, createIsolatedNetwork, removeEgressNetwork, removeIsolatedNetwork, runContained } from "../containment/index.ts";
import { startContainerizedRelay } from "./container/index.ts";

const IMAGE = "alpine";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("a worker box on the isolated network reaches only the relay container, never the open internet directly", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");

  const workdir = mkdtempSync(join(tmpdir(), "fabrica-relay-isolation-workdir-"));
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-relay-isolation-record-"));
  const isolatedNetworkName = `fabrica-test-relay-isolated-${process.pid}`;
  const egressNetworkName = `fabrica-test-relay-egress-${process.pid}`;

  const isolatedNetwork = await createIsolatedNetwork(isolatedNetworkName);
  const egressNetwork = await createEgressNetwork(egressNetworkName);
  const relay = await startContainerizedRelay({
    recordHome,
    taskId: "t1",
    isolatedNetwork: isolatedNetwork.name,
    egressNetwork: egressNetwork.name,
    tunnelAllowlist: [{ host: "github.com" }],
  });

  try {
    const reachesRelay = await runContained("nc", ["-z", "-w", "3", relay.host, String(relay.port)], {
      workdir,
      network: { isolatedNetwork: isolatedNetworkName },
      image: IMAGE,
    });
    assert.equal(reachesRelay.exitCode, 0, "the worker box must be able to reach the relay container on the isolated network");

    const reachesInternet = await runContained("nc", ["-z", "-w", "3", "1.1.1.1", "443"], {
      workdir,
      network: { isolatedNetwork: isolatedNetworkName },
      image: IMAGE,
    });
    assert.notEqual(reachesInternet.exitCode, 0, "the worker box must not be able to reach the open internet directly");
  } finally {
    await relay.close();
    await removeIsolatedNetwork(isolatedNetworkName);
    await removeEgressNetwork(egressNetworkName);
  }
});

test("the relay container itself can reach the real internet through its egress network", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");

  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-relay-isolation-record-"));
  const isolatedNetworkName = `fabrica-test-relay-isolated-egress-${process.pid}`;
  const egressNetworkName = `fabrica-test-relay-egress-egress-${process.pid}`;

  const isolatedNetwork = await createIsolatedNetwork(isolatedNetworkName);
  const egressNetwork = await createEgressNetwork(egressNetworkName);
  const relay = await startContainerizedRelay({
    recordHome,
    taskId: "t1",
    isolatedNetwork: isolatedNetwork.name,
    egressNetwork: egressNetwork.name,
    tunnelAllowlist: [{ host: "1.1.1.1", port: 443 }],
  });

  try {
    // A CONNECT to an allowlisted real-internet host, driven through the
    // worker container exactly as it would be in real use - proves the
    // relay's own egress leg actually reaches the internet, not just
    // that the worker can reach the relay.
    const workdir = mkdtempSync(join(tmpdir(), "fabrica-relay-isolation-workdir-egress-"));
    const result = await runContained(
      "sh",
      ["-c", `printf 'CONNECT 1.1.1.1:443 HTTP/1.1\\r\\nHost: 1.1.1.1\\r\\n\\r\\n' | nc -w 3 ${relay.host} ${relay.port}`],
      { workdir, network: { isolatedNetwork: isolatedNetworkName }, image: IMAGE }
    );
    assert.match(result.stdout, /200/, `expected the relay to tunnel the CONNECT through to a real host, got: ${result.stdout}`);
  } finally {
    await relay.close();
    await removeIsolatedNetwork(isolatedNetworkName);
    await removeEgressNetwork(egressNetworkName);
  }
});
