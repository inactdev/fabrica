// The real proof for issue #186's first half: a fake worker (plain
// node:net/node:http, standing in for a worker box's HTTP client) and a
// fake provider (helpers/fake-provider.ts) drive the relay exactly the
// way the issue describes, with nothing mocked inside the relay itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEventsForTask } from "../record/index.ts";
import { startRelay } from "./server.ts";
import { startFakeProvider } from "./helpers/fake-provider.ts";

function freshRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-relay-record-"));
}

// A fake worker's gateway-mode call: a plain HTTP request sent straight
// at the relay's own address, the way a worker whose base URL was
// pointed at the relay would send one - never at the real provider.
function requestThroughGateway(port: number, opts: { headers?: http.OutgoingHttpHeaders; path?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: opts.path ?? "/v1/messages", headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("error", reject);
    req.end("worker request body");
  });
}

// A fake worker's tunnel-mode call: the raw CONNECT handshake any
// HTTP_PROXY-aware client performs, written by hand so the test controls
// exactly what crosses the wire with nothing from node:http's own client
// smoothing it over.
function connectThroughTunnel(relayPort: number, target: string): Promise<{ socket: net.Socket; status: number }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(relayPort, "127.0.0.1", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    socket.once("error", reject);
    socket.once("data", (chunk: Buffer) => {
      const statusLine = chunk.toString("utf8").split("\r\n")[0] ?? "";
      const status = Number(statusLine.split(" ")[1]);
      resolve({ socket, status });
    });
  });
}

test("gateway mode: the real credential reaches the provider, never the fake one", async () => {
  const provider = await startFakeProvider({ body: "provider said hi" });
  const relay = await startRelay({
    recordHome: freshRecordHome(),
    taskId: "t1",
    tunnelAllowlist: [],
    gateway: {
      host: "127.0.0.1",
      port: provider.port,
      tls: false,
      credential: { header: "authorization", fakeValue: "fake-key-123", realValue: "sk-real-secret-999" },
    },
  });

  try {
    const result = await requestThroughGateway(relay.port, { headers: { authorization: "fake-key-123" } });
    assert.equal(result.status, 200);
    assert.equal(result.body, "provider said hi");

    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0]?.headers.authorization, "sk-real-secret-999", "the real key must reach the provider");
    assert.equal(provider.requests[0]?.body, "worker request body");
  } finally {
    await relay.close();
    await provider.close();
  }
});

test("gateway mode: the swap happens even if the worker sent no credential at all", async () => {
  const provider = await startFakeProvider();
  const relay = await startRelay({
    recordHome: freshRecordHome(),
    taskId: "t1",
    tunnelAllowlist: [],
    gateway: {
      host: "127.0.0.1",
      port: provider.port,
      tls: false,
      credential: { header: "authorization", fakeValue: "fake-key-123", realValue: "sk-real-secret-999" },
    },
  });

  try {
    await requestThroughGateway(relay.port, {});
    assert.equal(provider.requests[0]?.headers.authorization, "sk-real-secret-999");
  } finally {
    await relay.close();
    await provider.close();
  }
});

test("gateway mode: a relay with no gateway configured refuses every request, not just unrecognized ones", async () => {
  const relay = await startRelay({ recordHome: freshRecordHome(), taskId: "t1", tunnelAllowlist: [] });
  try {
    const result = await requestThroughGateway(relay.port, {});
    assert.equal(result.status, 501);
  } finally {
    await relay.close();
  }
});

test("tunnel mode: an allowed host is tunneled through untouched", async () => {
  const upstream = await startFakeProvider({ body: "tunneled bytes" });
  const recordHome = freshRecordHome();
  const relay = await startRelay({
    recordHome,
    taskId: "t1",
    tunnelAllowlist: [{ host: "127.0.0.1", port: upstream.port }],
  });

  try {
    const { socket, status } = await connectThroughTunnel(relay.port, `127.0.0.1:${upstream.port}`);
    assert.equal(status, 200);

    const response = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      socket.on("data", (c: Buffer) => chunks.push(c));
      socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      socket.write("GET / HTTP/1.1\r\nHost: upstream\r\nConnection: close\r\n\r\n");
    });
    assert.ok(response.includes("tunneled bytes"), `expected tunneled body in response, got: ${response}`);
    assert.equal(readEventsForTask(recordHome, "t1").length, 0, "an allowed tunnel must not be recorded as a refusal");
  } finally {
    await relay.close();
    await upstream.close();
  }
});

test("tunnel mode: a host outside the allowlist is refused and named on the record", async () => {
  const recordHome = freshRecordHome();
  const relay = await startRelay({
    recordHome,
    taskId: "t1",
    tunnelAllowlist: [{ host: "github.com" }],
  });

  try {
    const { socket, status } = await connectThroughTunnel(relay.port, "evil.example.com:443");
    assert.equal(status, 403);
    socket.destroy();

    const events = readEventsForTask(recordHome, "t1");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.name, "network-refused");
    assert.deepEqual(events[0]?.details, { host: "evil.example.com", port: 443 });
  } finally {
    await relay.close();
  }
});

test("tunnel mode: two different tasks' refusals land on their own task's events only", async () => {
  const recordHome = freshRecordHome();
  const relayA = await startRelay({ recordHome, taskId: "task-a", tunnelAllowlist: [] });
  const relayB = await startRelay({ recordHome, taskId: "task-b", tunnelAllowlist: [] });

  try {
    await connectThroughTunnel(relayA.port, "evil.example.com:443");
    await connectThroughTunnel(relayB.port, "also-evil.example.com:443");

    assert.equal(readEventsForTask(recordHome, "task-a").length, 1);
    assert.equal(readEventsForTask(recordHome, "task-b").length, 1);
    assert.equal(readEventsForTask(recordHome, "task-a")[0]?.details && (readEventsForTask(recordHome, "task-a")[0]?.details as { host: string }).host, "evil.example.com");
  } finally {
    await relayA.close();
    await relayB.close();
  }
});
