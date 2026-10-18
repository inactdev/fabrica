// @ts-check
// The relay itself (issue #186, first half): a host-side process every
// worker box's traffic is forced through instead of reaching the
// network directly. Two traffic shapes, handled differently on purpose:
//
// - A CONNECT request (git over HTTPS, npm, anything that just needs a
//   TCP/TLS tunnel) is allowed or refused by hostname alone, then piped
//   byte-for-byte - the relay never looks inside it, so it cannot swap
//   a credential riding inside this kind of traffic either.
// - An ordinary request (no CONNECT) is "gateway" traffic: forwarded to
//   the one upstream this relay was configured with, after the
//   configured header's value is replaced with the real credential.
//   This is how a fake-key-for-real-key swap happens without ever
//   terminating the worker's TLS (see README.md's "Why not TLS
//   termination" for why that was the deciding factor against
//   sandbox-runtime).
//
// A worker's HTTP client reaches gateway traffic by having its base URL
// pointed at the relay directly (so there's no destination to parse out
// of the request - the relay's one configured upstream *is* the
// destination), and tunnel traffic through the ordinary
// HTTP_PROXY/HTTPS_PROXY mechanism every HTTP client already knows.
//
// Plain JavaScript importing only `node:` built-ins and sibling .mjs
// files: the relay container runs this with a stock `node` and nothing
// from node_modules (see container/bootstrap.mjs). That is also why the
// refusal event is written here directly rather than through
// src/record/'s appendEvent (TypeScript) - same file, same one-line
// O_APPEND write, same short-write refusal.

import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isAllowedTarget } from "./allowlist.mjs";
import { DEFAULT_MAX_CALLS_PER_TASK, DEFAULT_MAX_REQUEST_BYTES } from "./limits.mjs";
import { RelayError } from "./errors.mjs";

/** @typedef {import("./types.ts").RelayOptions} RelayOptions */
/** @typedef {import("./types.ts").RelayHandle} RelayHandle */
/** @typedef {import("../record/types.ts").FabricaEvent} FabricaEvent */

/**
 * Appends one `"network-refused"` event to `<recordHome>/events.jsonl`,
 * the same line shape src/record/append.ts writes. `details` always
 * names the host and port the worker box was trying to reach; a refusal
 * caused by one of the limits (limits.mjs) additionally names which.
 * @param {string} recordHome
 * @param {string} taskId
 * @param {Record<string, unknown>} details
 */
function appendRefusal(recordHome, taskId, details) {
  /** @type {FabricaEvent} */
  const record = { occurredAt: new Date().toISOString(), taskId, name: "network-refused", details };
  const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  const path = join(recordHome, "events.jsonl");

  mkdirSync(recordHome, { recursive: true });
  const fd = openSync(path, "a");
  try {
    const written = writeSync(fd, line);
    if (written !== line.byteLength) {
      throw new Error(
        `The record at ${path} accepted only ${written} of ${line.byteLength} bytes for this event (is the disk full?). ` +
          `The event was not fully written.`,
      );
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * @param {string} url
 * @returns {{ host: string, port: number } | undefined}
 */
function parseConnectTarget(url) {
  // CONNECT's request-target is authority-form, "host:port" - never a
  // scheme, never a path. Split on the last colon so an unexpected IPv6
  // literal (which this module does not otherwise support) fails to
  // parse rather than silently matching the wrong host.
  const lastColon = url.lastIndexOf(":");
  if (lastColon <= 0) return undefined;
  const host = url.slice(0, lastColon);
  const port = Number(url.slice(lastColon + 1));
  if (!host || !Number.isInteger(port) || port <= 0) return undefined;
  return { host, port };
}

/**
 * @param {RelayOptions} opts
 * @returns {Promise<RelayHandle>}
 */
export async function startRelay(opts) {
  if (opts.gateway !== undefined && opts.gateway.host === "") {
    throw new RelayError("invalid-config", "gateway.host must not be empty");
  }
  if (opts.gateway?.credential !== undefined && opts.gateway.credential.header === "") {
    throw new RelayError("invalid-config", "gateway.credential.header must not be empty");
  }

  const maxRequestBytes = opts.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const maxCallsPerTask = opts.maxCallsPerTask ?? DEFAULT_MAX_CALLS_PER_TASK;

  /**
   * @param {string} host
   * @param {number} port
   * @param {Record<string, unknown>} [extra]
   */
  const recordRefusal = (host, port, extra) => {
    appendRefusal(opts.recordHome, opts.taskId, { host, port, ...extra });
  };

  // One call is one gateway request, or one CONNECT tunnel. Counted per
  // relay, which is per task: a relay is started for one task's worker
  // box and torn down with it (src/relay/container/launch.ts).
  let calls = 0;
  // The call limit is recorded on the task once, not once per refused
  // call past it: events.jsonl is shared by every task in a record home
  // and is re-read whole by `fabrica status`/`watch`, so a worker
  // looping against an exhausted limit would otherwise write an
  // unbounded run of identical lines. Every later call is still
  // refused - it just adds nothing new to the record. A refused *host*
  // is recorded every time, since each can name a different host.
  let callLimitRecorded = false;

  /** True (and the refusal recorded) when this call is one too many.
   * @param {string} host
   * @param {number} port */
  const overCallLimit = (host, port) => {
    calls += 1;
    if (calls <= maxCallsPerTask) return false;
    if (!callLimitRecorded) {
      callLimitRecorded = true;
      recordRefusal(host, port, { limit: "calls-per-task", maxCallsPerTask, calls });
    }
    return true;
  };

  const server = http.createServer((req, res) => {
    const gateway = opts.gateway;
    if (gateway === undefined) {
      res.writeHead(501, { "content-type": "text/plain" }).end("no gateway configured for this relay");
      return;
    }

    const gatewayPort = gateway.port ?? 443;
    if (overCallLimit(gateway.host, gatewayPort)) {
      res
        .writeHead(429, { "content-type": "text/plain" })
        .end(`relay: this task has already made ${maxCallsPerTask} calls, its limit`);
      return;
    }

    // Declared size first, so an oversized body is refused before a
    // single byte of it is forwarded anywhere. A request that declares
    // nothing (chunked) is counted as it streams instead, below.
    const declaredLength = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > maxRequestBytes) {
      recordRefusal(gateway.host, gatewayPort, { limit: "request-size", maxRequestBytes, requestBytes: declaredLength });
      res
        .writeHead(413, { "content-type": "text/plain" })
        .end(`relay: request of ${declaredLength} bytes is over this task's ${maxRequestBytes}-byte limit`);
      return;
    }

    /** @type {http.OutgoingHttpHeaders} */
    const headers = { ...req.headers };
    delete headers.connection;
    headers.host = gateway.port === undefined ? gateway.host : `${gateway.host}:${gateway.port}`;
    if (gateway.credential !== undefined) {
      headers[gateway.credential.header.toLowerCase()] = gateway.credential.realValue;
    }

    const transport = gateway.tls === false ? http : https;
    const upstreamReq = transport.request(
      { host: gateway.host, port: gateway.port ?? 443, method: req.method, path: req.url, headers },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );
    // A body with no declared length (chunked) is measured as it
    // arrives: the moment it passes the limit the upstream request is
    // abandoned mid-flight, so an oversized body is never delivered
    // whole even though its size was unknowable up front. The listener
    // sees the same chunks the pipe below forwards - adding it does not
    // consume them. The request itself is left alone rather than
    // destroyed: once this response has ended, Node discards whatever
    // the client is still sending, without ever handing it on.
    let forwarded = 0;
    let refusedMidStream = false;
    req.on("data", (/** @type {Buffer} */ chunk) => {
      if (refusedMidStream) return;
      forwarded += chunk.length;
      if (forwarded <= maxRequestBytes) return;
      refusedMidStream = true;
      recordRefusal(gateway.host, gatewayPort, { limit: "request-size", maxRequestBytes, requestBytes: forwarded });
      req.unpipe(upstreamReq);
      upstreamReq.destroy();
      if (!res.headersSent) {
        res
          .writeHead(413, { "content-type": "text/plain" })
          .end(`relay: request body passed this task's ${maxRequestBytes}-byte limit`);
      }
    });

    upstreamReq.on("error", () => {
      // The destroy above is this relay's own doing, and the 413 it
      // already sent is the honest answer - never overwrite it with a
      // 502 about an upstream that was fine.
      if (refusedMidStream) return;
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("relay: upstream gateway request failed");
    });
    req.pipe(upstreamReq);
  });

  server.on("connect", (req, /** @type {net.Socket} */ clientSocket, /** @type {Buffer} */ head) => {
    const target = req.url !== undefined ? parseConnectTarget(req.url) : undefined;
    if (target === undefined) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }

    if (overCallLimit(target.host, target.port)) {
      clientSocket.end("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      return;
    }

    if (!isAllowedTarget(target.host, target.port, opts.tunnelAllowlist)) {
      recordRefusal(target.host, target.port);
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }

    const upstreamSocket = net.connect(target.port, target.host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
    upstreamSocket.on("error", () => clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
    clientSocket.on("error", () => upstreamSocket.destroy());
  });

  await /** @type {Promise<void>} */ (
    new Promise((resolve, reject) => {
      server.once("error", (err) => reject(new RelayError("listen-failed", `relay could not bind a port: ${err instanceof Error ? err.message : String(err)}`)));
      server.listen(opts.port ?? 0, opts.bindAddress ?? "127.0.0.1", () => resolve());
    })
  );

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new RelayError("listen-failed", "relay listened but reported no port");
  }

  return {
    port: address.port,
    close: () =>
      /** @type {Promise<void>} */ (
        new Promise((resolve) => {
          server.close(() => resolve());
        })
      ),
  };
}
