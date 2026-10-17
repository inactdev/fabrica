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
import { RelayError } from "./errors.mjs";

/** @typedef {import("./types.ts").RelayOptions} RelayOptions */
/** @typedef {import("./types.ts").RelayHandle} RelayHandle */
/** @typedef {import("../record/types.ts").FabricaEvent} FabricaEvent */

/**
 * Appends one `"network-refused"` event to `<recordHome>/events.jsonl`,
 * the same line shape src/record/append.ts writes.
 * @param {string} recordHome
 * @param {string} taskId
 * @param {string} host
 * @param {number} port
 */
function appendRefusal(recordHome, taskId, host, port) {
  /** @type {FabricaEvent} */
  const record = { occurredAt: new Date().toISOString(), taskId, name: "network-refused", details: { host, port } };
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

  /**
   * @param {string} host
   * @param {number} port
   */
  const recordRefusal = (host, port) => {
    appendRefusal(opts.recordHome, opts.taskId, host, port);
  };

  const server = http.createServer((req, res) => {
    const gateway = opts.gateway;
    if (gateway === undefined) {
      res.writeHead(501, { "content-type": "text/plain" }).end("no gateway configured for this relay");
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
    upstreamReq.on("error", () => {
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
