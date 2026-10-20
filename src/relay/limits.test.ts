// Issue #186: "the relay enforces a request-size limit and a per-task
// call limit". Both are refusals of one request - the task keeps
// running, since rule 10's spending cap is the only thing that stops a
// task (Client ruling) - and both are reported naming which limit was
// hit, which the host side turns into that task's own
// "network-refused" event (container/launch.ts).
//
// Driven the same way server.test.ts drives the rest of the relay: a
// fake worker (plain node:net/node:http) and a fake provider, with
// nothing mocked inside the relay itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as http from "node:http";
import { startRelay } from "./server.mjs";
import { collectRefusals } from "./helpers/collect-refusals.ts";
import { startFakeProvider } from "./helpers/fake-provider.ts";
import type { FakeProviderHandle } from "./helpers/fake-provider.ts";
import type { RefusalDetails, RelayHandle } from "./types.ts";

/** One gateway-mode request with a body of exactly `bytes` bytes.
 * `chunked` sends it without a content-length, which is the case the
 * relay can only catch while the body is already streaming. */
function postBody(
  port: number,
  bytes: number,
  opts: { chunked?: boolean } = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.alloc(bytes, 0x61);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/v1/messages",
        headers: opts.chunked ? { "transfer-encoding": "chunked" } : { "content-length": String(bytes) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    // A request the relay refuses mid-body leaves this socket's write
    // side with nowhere to go; the answer already arrived, so an error
    // here is the refusal working, not a test failure.
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "ECONNRESET" && err.code !== "EPIPE") reject(err);
    });
    req.end(payload);
  });
}

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

async function withGatewayRelay(
  limits: { maxRequestBytes?: number; maxCallsPerTask?: number },
  body: (relay: RelayHandle, provider: FakeProviderHandle, refusals: RefusalDetails[]) => Promise<void>
): Promise<void> {
  const provider = await startFakeProvider({ body: "provider said hi" });
  const reported = collectRefusals();
  const relay = await startRelay({
    onRefusal: reported.onRefusal,
    tunnelAllowlist: [{ host: "allowed.example" }],
    gateway: { host: "127.0.0.1", port: provider.port, tls: false },
    ...limits,
  });
  try {
    await body(relay, provider, reported.refusals);
  } finally {
    await relay.close();
    await provider.close();
  }
}

test("a request over the size limit is refused, named in the refusal, and never forwarded", async () => {
  await withGatewayRelay({ maxRequestBytes: 64 }, async (relay, provider, refusals) => {
    const refused = await postBody(relay.port, 500);
    assert.equal(refused.status, 413);
    assert.equal(provider.requests.length, 0, "an oversized request must not reach the provider at all");

    assert.deepEqual(refusals, [
      {
        host: "127.0.0.1",
        port: provider.port,
        limit: "request-size",
        maxRequestBytes: 64,
        requestBytes: 500,
      },
    ]);

    // The task is not stopped: the very next request, within the
    // limit, goes through as if nothing had happened.
    const allowed = await postBody(relay.port, 8);
    assert.equal(allowed.status, 200);
    assert.equal(provider.requests.length, 1);
  });
});

test("a body that declares no length is measured as it streams, and cut off over the limit", async () => {
  await withGatewayRelay({ maxRequestBytes: 64 }, async (relay, provider, refusals) => {
    const refused = await postBody(relay.port, 4096, { chunked: true });
    assert.equal(refused.status, 413);

    assert.equal(refusals.length, 1);
    const details = refusals[0] as unknown as { limit: string; maxRequestBytes: number; requestBytes: number };
    assert.equal(details.limit, "request-size");
    assert.equal(details.maxRequestBytes, 64);
    assert.ok(details.requestBytes > 64, `expected the refusal to name how far over it got, got ${details.requestBytes}`);
    assert.equal(
      provider.requests.length,
      0,
      "a body cut off mid-stream must never be delivered to the provider as a complete request"
    );
  });
});

test("a request within the size limit is forwarded untouched", async () => {
  await withGatewayRelay({ maxRequestBytes: 64 }, async (relay, provider, refusals) => {
    const result = await postBody(relay.port, 64);
    assert.equal(result.status, 200);
    assert.equal(provider.requests[0]?.body.length, 64);
    assert.deepEqual(refusals, [], "a request within the limit is not a refusal");
  });
});

test("past the per-task call limit every further call is refused, and it is reported once", async () => {
  await withGatewayRelay({ maxCallsPerTask: 2 }, async (relay, provider, refusals) => {
    assert.equal((await postBody(relay.port, 4)).status, 200);
    assert.equal((await postBody(relay.port, 4)).status, 200);

    const third = await postBody(relay.port, 4);
    assert.equal(third.status, 429);
    assert.match(third.body, /2 calls/);
    const fourth = await postBody(relay.port, 4);
    assert.equal(fourth.status, 429);

    assert.equal(provider.requests.length, 2, "only the calls within the limit reach the provider");

    // Reported once, not once per refused call: each report becomes a
    // line in events.jsonl, which is shared by every task in a record
    // home and re-read whole by `fabrica status`, so a worker looping
    // against an exhausted limit must not be able to grow it without
    // bound.
    assert.deepEqual(refusals, [
      {
        host: "127.0.0.1",
        port: provider.port,
        limit: "calls-per-task",
        maxCallsPerTask: 2,
        calls: 3,
      },
    ]);
  });
});

test("a CONNECT tunnel counts as one call against the same limit", async () => {
  const upstream = await startFakeProvider();
  const reported = collectRefusals();
  const relay = await startRelay({
    onRefusal: reported.onRefusal,
    tunnelAllowlist: [{ host: "127.0.0.1" }],
    maxCallsPerTask: 1,
  });

  try {
    const first = await connect(relay.port, `127.0.0.1:${upstream.port}`);
    assert.equal(first.status, 200);
    first.socket.destroy();

    const second = await connect(relay.port, `127.0.0.1:${upstream.port}`);
    assert.equal(second.status, 429, "an allowed host is still refused once the task is out of calls");
    second.socket.destroy();

    assert.equal(reported.refusals.length, 1);
    assert.equal(reported.refusals[0]?.limit, "calls-per-task");
  } finally {
    await relay.close();
    await upstream.close();
  }
});
