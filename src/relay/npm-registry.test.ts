// Issue #186: "a test proves `npm ci` inside the box works for a
// project that lists the registry". This is the hermetic half (Client
// ruling: both a hermetic one and a Docker-gated one) - the whole
// chain from a real projects.toml to a real relay decision, against a
// fake registry, with no Docker and no internet involved:
//
//   projects.toml -> networkPolicyFor -> tunnelAllowlistFor -> startRelay
//
// What it deliberately does not do is run npm itself. A real npm client
// reaches an `https:` registry through a CONNECT tunnel (verified
// against the installed npm's own source: @npmcli/config's `https-proxy`
// definition documents that HTTPS_PROXY/https_proxy/HTTP_PROXY/
// http_proxy are honored, and @npmcli/agent's proxy.js resolves an
// `https:` URL's proxy from the lowercased env and reaches it through
// HttpsProxyAgent, i.e. CONNECT), so what decides whether `npm ci`
// works is exactly the tunnel decision driven below - and standing up
// a throwaway TLS certificate to say the same thing with npm's name on
// it would make a fast test slower and more fragile, not more true.
// npm-ci-in-box.test.ts runs the real thing, against the real registry,
// wherever Docker is.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEventsForTask } from "../record/index.ts";
import { networkPolicyFor } from "../foreman/network-policy.ts";
import { startRelay } from "./server.mjs";
import { tunnelAllowlistFor } from "./policy.ts";
import type { AllowedHost } from "./types.ts";

// Stands in for whatever hosts an adapter always allows (its model
// provider's own, which only src/brain/adapters/ may name, plus
// GitHub) - the point of these tests is what a project's own
// declaration adds to them.
const BASE: AllowedHost[] = [{ host: "model.example" }];

/** A registry just real enough to answer the one request a client makes
 * first: the packument for a package. Served over plain HTTP and
 * reached through the relay's CONNECT tunnel, which is raw TCP - a
 * tunnel does not care what rides inside it. */
async function startFakeRegistry(): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: "left-pad", "dist-tags": { latest: "1.0.0" }, _requested: req.url }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake registry listened but reported no port");
  return { port: address.port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** A record home with one registered project, written exactly the way a
 * Client writes it by hand. `hosts` is omitted entirely when the test
 * is about a project that declares none. */
function homeFor(project: string, hosts?: string[]): string {
  const home = mkdtempSync(join(tmpdir(), "fabrica-npm-registry-home-"));
  writeFileSync(
    join(home, "projects.toml"),
    `[projects.demo]\npath = "${project}"\ncheck = "./check.sh"\n` +
      (hosts === undefined ? "" : `hosts = [${hosts.map((h) => `"${h}"`).join(", ")}]\n`)
  );
  return home;
}

/** The CONNECT handshake any HTTP_PROXY-aware client (npm included)
 * performs for an https URL, written by hand so the test controls
 * exactly what crosses the wire. */
function connect(relayPort: number, target: string): Promise<{ socket: net.Socket; status: number }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(relayPort, "127.0.0.1", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    socket.once("error", reject);
    socket.once("data", (chunk: Buffer) => {
      resolve({ socket, status: Number(chunk.toString("utf8").split("\r\n")[0]?.split(" ")[1]) });
    });
  });
}

function fetchThrough(socket: net.Socket, path: string): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    socket.on("data", (c: Buffer) => chunks.push(c));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.write(`GET ${path} HTTP/1.1\r\nHost: registry\r\nConnection: close\r\n\r\n`);
  });
}

test("a project that lists the registry reaches it through the relay", async () => {
  const registry = await startFakeRegistry();
  // The project path need not exist for the registry lookup itself -
  // networkPolicyFor only matches on the path - but a real directory
  // keeps the fixture honest about what a registered project is.
  const project = mkdtempSync(join(tmpdir(), "fabrica-npm-registry-project-"));
  const recordHome = homeFor(project, [`127.0.0.1:${registry.port}`]);

  const policy = networkPolicyFor(recordHome, "t1", project);
  const relay = await startRelay({
    recordHome,
    taskId: policy.taskId,
    tunnelAllowlist: tunnelAllowlistFor(BASE, policy),
  });

  try {
    const { socket, status } = await connect(relay.port, `127.0.0.1:${registry.port}`);
    assert.equal(status, 200, "a listed registry must be tunneled, not refused");

    const response = await fetchThrough(socket, "/left-pad");
    assert.match(response, /left-pad/, `expected the registry's own answer through the tunnel, got: ${response}`);
    assert.equal(readEventsForTask(recordHome, "t1").length, 0, "nothing was refused, so nothing is on the record");
  } finally {
    await relay.close();
    await registry.close();
  }
});

test("a project that lists nothing cannot reach the registry, and the refusal names it", async () => {
  const registry = await startFakeRegistry();
  const project = mkdtempSync(join(tmpdir(), "fabrica-npm-registry-project-"));
  const recordHome = homeFor(project);

  const policy = networkPolicyFor(recordHome, "t2", project);
  const relay = await startRelay({
    recordHome,
    taskId: policy.taskId,
    tunnelAllowlist: tunnelAllowlistFor(BASE, policy),
  });

  try {
    const { socket, status } = await connect(relay.port, `127.0.0.1:${registry.port}`);
    assert.equal(status, 403);
    socket.destroy();

    const events = readEventsForTask(recordHome, "t2");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.name, "network-refused");
    assert.deepEqual(events[0]?.details, { host: "127.0.0.1", port: registry.port });
  } finally {
    await relay.close();
    await registry.close();
  }
});

test("declaring the registry does not cost a project the hosts it always had", async () => {
  const project = mkdtempSync(join(tmpdir(), "fabrica-npm-registry-project-"));
  const recordHome = homeFor(project, ["registry.npmjs.org"]);

  const allowlist = tunnelAllowlistFor(BASE, networkPolicyFor(recordHome, "t3", project));
  assert.deepEqual(allowlist, [{ host: "model.example" }, { host: "registry.npmjs.org" }]);
});
