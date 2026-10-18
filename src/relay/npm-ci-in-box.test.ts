// Issue #186: "a test proves `npm ci` inside the box works for a
// project that lists the registry" - the real half (Client ruling:
// hermetic *and* real, "since the point is that the real path works").
// A real worker box on a real isolated network, a real relay container
// beside it, and a real `npm ci` against the real registry.npmjs.org,
// reached the only way that network allows: through the relay's CONNECT
// tunnel, because the project's own projects.toml entry lists the
// registry host.
//
// Skips (never fails) without Docker, the same convention
// docker-isolation.test.ts and src/containment/run.test.ts already use -
// and runs for real under .github/workflows/docker-tests.yml, which
// exists so these stop depending on someone checking by hand.
//
// The image is RELAY_IMAGE: the stock, digest-pinned Node image the
// relay container itself runs from, so this needs nothing built
// locally - it ships npm, which is the whole requirement here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEgressNetwork,
  createIsolatedNetwork,
  removeEgressNetwork,
  removeIsolatedNetwork,
  runContained,
} from "../containment/index.ts";
import { readEventsForTask } from "../record/index.ts";
import { RELAY_IMAGE, startContainerizedRelay } from "./container/index.ts";
import { tunnelAllowlistFor } from "./policy.ts";
import type { AllowedHost } from "./types.ts";

const REGISTRY_HOST = "registry.npmjs.org";

/** Stands in for an adapter's own base hosts (its model provider, which
 * only src/brain/adapters/ may name, plus GitHub): deliberately not the
 * registry, so nothing but the project's own declaration can be what
 * makes the install work. */
const BASE: AllowedHost[] = [{ host: "model.example" }];

/** A real package, chosen because this repository already depends on it
 * - so the test is never the thing that discovers a name or version
 * does not exist - and because it is small enough that a CI run spends
 * a second on it, not a minute. */
const DEPENDENCY = `{ "name": "fabrica-relay-npm-ci-fixture", "version": "1.0.0", "private": true, "dependencies": { "smol-toml": "^1.7.1" } }`;

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** `npm ci` needs a lockfile, and one written by hand would carry
 * integrity hashes invented here. It is generated inside the box
 * instead, through the same relay - metadata first, then the real
 * install - so both halves of what a project's check does on a fresh
 * checkout are exercised. Retries off: the refused case must fail
 * promptly instead of backing off three times against a relay that
 * will keep saying no. */
const INSTALL = "npm install --package-lock-only --no-audit --no-fund && npm ci --no-audit --no-fund";

interface Box {
  isolatedNetwork: string;
  egressNetwork: string;
  recordHome: string;
  workdir: string;
}

function names(suffix: string): Box {
  const workdir = mkdtempSync(join(tmpdir(), `fabrica-npm-ci-${suffix}-`));
  writeFileSync(join(workdir, "package.json"), DEPENDENCY);
  return {
    isolatedNetwork: `fabrica-test-npm-ci-${suffix}-${process.pid}`,
    egressNetwork: `fabrica-test-npm-ci-egress-${suffix}-${process.pid}`,
    recordHome: mkdtempSync(join(tmpdir(), `fabrica-npm-ci-record-${suffix}-`)),
    workdir,
  };
}

async function installThroughRelay(box: Box, taskId: string, declaredHosts: string[]) {
  const isolated = await createIsolatedNetwork(box.isolatedNetwork);
  const egress = await createEgressNetwork(box.egressNetwork);
  const relay = await startContainerizedRelay({
    recordHome: box.recordHome,
    taskId,
    isolatedNetwork: isolated.name,
    egressNetwork: egress.name,
    tunnelAllowlist: tunnelAllowlistFor(BASE, { hosts: declaredHosts }),
  });

  try {
    const proxy = `http://${relay.host}:${relay.port}`;
    return await runContained("sh", ["-c", INSTALL], {
      workdir: box.workdir,
      network: { isolatedNetwork: box.isolatedNetwork },
      image: RELAY_IMAGE,
      // A home of its own: npm writes its cache under $HOME, and a
      // container run as an unprivileged --user has nowhere else to
      // put it (src/containment/README.md's "$HOME" note).
      homeDir: mkdtempSync(join(tmpdir(), "fabrica-npm-ci-home-")),
      env: {
        // npm reads these lowercased (verified in @npmcli/agent's own
        // proxy.js), and an `https:` registry URL resolves its proxy
        // from https_proxy first - which is what turns every registry
        // request into a CONNECT the relay gets to judge.
        HTTPS_PROXY: proxy,
        HTTP_PROXY: proxy,
        https_proxy: proxy,
        http_proxy: proxy,
        npm_config_fetch_retries: "0",
      },
    });
  } finally {
    await relay.close();
    await removeIsolatedNetwork(box.isolatedNetwork);
    await removeEgressNetwork(box.egressNetwork);
  }
}

test("npm ci inside the box works for a project that lists the registry", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");

  const box = names("listed");
  const result = await installThroughRelay(box, "t1", [REGISTRY_HOST]);

  assert.equal(
    result.exitCode,
    0,
    `npm ci should have succeeded through the relay.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  assert.equal(readEventsForTask(box.recordHome, "t1").length, 0, "nothing should have been refused");
});

test("the same install is refused for a project that lists nothing, and the record names the registry", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");

  const box = names("unlisted");
  const result = await installThroughRelay(box, "t2", []);

  assert.notEqual(result.exitCode, 0, "a registry the project never declared must not be reachable");

  const refusals = readEventsForTask(box.recordHome, "t2");
  assert.ok(refusals.length > 0, "the refusal must be on the task's own record");
  assert.equal(refusals[0]?.name, "network-refused");
  assert.deepEqual(refusals[0]?.details, { host: REGISTRY_HOST, port: 443 });
});
