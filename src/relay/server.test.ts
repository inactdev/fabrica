// The real proof for issue #186's first half: a fake worker (plain
// node:net/node:http, standing in for a worker box's HTTP client) and a
// fake provider (helpers/fake-provider.ts) drive the relay exactly the
// way the issue describes, with nothing mocked inside the relay itself.
//
// The last test in this file is the 2026-10-18 crash: the relay used to
// die on a refusal, so everything a worker asked for afterwards was
// refused by an address with nothing listening on it.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as http from "node:http";
import { startRelay } from "./server.mjs";
import { collectRefusals } from "./helpers/collect-refusals.ts";
import { startFakeProvider } from "./helpers/fake-provider.ts";

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
  const relay = await startRelay({ tunnelAllowlist: [] });
  try {
    const result = await requestThroughGateway(relay.port, {});
    assert.equal(result.status, 501);
  } finally {
    await relay.close();
  }
});

test("tunnel mode: an allowed host is tunneled through untouched", async () => {
  const upstream = await startFakeProvider({ body: "tunneled bytes" });
  const reported = collectRefusals();
  const relay = await startRelay({
    onRefusal: reported.onRefusal,
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
    assert.deepEqual(reported.refusals, [], "an allowed tunnel must not be reported as a refusal");
  } finally {
    await relay.close();
    await upstream.close();
  }
});

test("tunnel mode: a host outside the allowlist is refused and named in the refusal", async () => {
  const reported = collectRefusals();
  const relay = await startRelay({ onRefusal: reported.onRefusal, tunnelAllowlist: [{ host: "github.com" }] });

  try {
    const { socket, status } = await connectThroughTunnel(relay.port, "evil.example.com:443");
    assert.equal(status, 403);
    socket.destroy();

    assert.deepEqual(reported.refusals, [{ host: "evil.example.com", port: 443 }]);
  } finally {
    await relay.close();
  }
});

test("tunnel mode: two relays' refusals stay with the relay that refused them", async () => {
  const reportedA = collectRefusals();
  const reportedB = collectRefusals();
  const relayA = await startRelay({ onRefusal: reportedA.onRefusal, tunnelAllowlist: [] });
  const relayB = await startRelay({ onRefusal: reportedB.onRefusal, tunnelAllowlist: [] });

  try {
    await connectThroughTunnel(relayA.port, "evil.example.com:443");
    await connectThroughTunnel(relayB.port, "also-evil.example.com:443");

    assert.deepEqual(reportedA.refusals, [{ host: "evil.example.com", port: 443 }]);
    assert.deepEqual(reportedB.refusals, [{ host: "also-evil.example.com", port: 443 }]);
  } finally {
    await relayA.close();
    await relayB.close();
  }
});

// The 2026-10-18 incident, as its own test. On task
// 20261018-make-the-installed-copy-of-fabrica-updat-i1 the record showed
// a refused `registry.npmjs.org` tunnel, then four minutes of
// heartbeats, then the worker's own `API Error: Unable to connect to API
// (ConnectionRefused)` - the relay had exited on the refusal itself, so
// every later request reached an address with nothing listening.
//
// The refusal was not what killed it: the client socket a refused
// CONNECT is answered on had no `error` listener (only the allowed path
// attached one), and npm resets that connection the moment it is
// refused, which in Node is an uncaught exception. Hence the
// `resetAndDestroy` below - a polite `end()` never reproduced it.
test("a refused tunnel cannot take the relay down - later requests still work", async () => {
  const provider = await startFakeProvider({ body: "provider said hi" });
  const reported = collectRefusals();
  const relay = await startRelay({
    onRefusal: reported.onRefusal,
    tunnelAllowlist: [{ host: "github.com" }],
    gateway: { host: "127.0.0.1", port: provider.port, tls: false },
  });

  try {
    const { socket, status } = await connectThroughTunnel(relay.port, "registry.npmjs.org:443");
    assert.equal(status, 403);
    // What a real client does with a connection it was just refused.
    socket.resetAndDestroy();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const after = await requestThroughGateway(relay.port, {});
    assert.equal(after.status, 200, "the relay must still be serving after a refusal");
    assert.equal(after.body, "provider said hi");
    assert.deepEqual(reported.refusals, [{ host: "registry.npmjs.org", port: 443 }]);
  } finally {
    await relay.close();
    await provider.close();
  }
});

test("a refusal nobody can report is dropped, not thrown - the relay keeps serving", async () => {
  const provider = await startFakeProvider({ body: "provider said hi" });
  let attempts = 0;
  const relay = await startRelay({
    // Stands in for every way reporting can fail where it now happens
    // (the host side's own append): what used to be an unwritable
    // record home throwing out of this very code path.
    onRefusal: () => {
      attempts += 1;
      throw new Error("EACCES: permission denied, mkdir '/nope/records'");
    },
    tunnelAllowlist: [{ host: "github.com" }],
    gateway: { host: "127.0.0.1", port: provider.port, tls: false },
  });

  try {
    const { socket, status } = await connectThroughTunnel(relay.port, "registry.npmjs.org:443");
    assert.equal(status, 403, "the refusal itself still has to be answered");
    socket.destroy();
    assert.equal(attempts, 1);

    const after = await requestThroughGateway(relay.port, {});
    assert.equal(after.status, 200, "a refusal that could not be reported must not cost the next request");
  } finally {
    await relay.close();
    await provider.close();
  }
});

test("a worker that abandons a gateway request mid-flight cannot take the relay down either", async () => {
  const provider = await startFakeProvider({ body: "provider said hi" });
  const relay = await startRelay({
    tunnelAllowlist: [],
    gateway: { host: "127.0.0.1", port: provider.port, tls: false },
  });

  try {
    await new Promise<void>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: relay.port, method: "POST", path: "/v1/messages" });
      req.on("error", () => resolve());
      req.write("half a body");
      // No end(): the socket is torn down with the request still open,
      // the way a worker whose own process dies mid-call leaves it.
      req.socket?.resetAndDestroy() ?? req.destroy();
      setTimeout(resolve, 50);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const after = await requestThroughGateway(relay.port, {});
    assert.equal(after.status, 200, "the relay must still be serving");
  } finally {
    await relay.close();
    await provider.close();
  }
});
