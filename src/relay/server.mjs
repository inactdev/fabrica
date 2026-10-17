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

import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import { appendEvent } from "../record/index.ts";
import { isAllowedTarget } from "./allowlist.ts";
import { RelayError } from "./errors.ts";
import type { RelayHandle, RelayOptions } from "./types.ts";

function parseConnectTarget(url: string): { host: string; port: number } | undefined {
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

export async function startRelay(opts: RelayOptions): Promise<RelayHandle> {
  if (opts.gateway !== undefined && opts.gateway.host === "") {
    throw new RelayError("invalid-config", "gateway.host must not be empty");
  }
  if (opts.gateway?.credential !== undefined && opts.gateway.credential.header === "") {
    throw new RelayError("invalid-config", "gateway.credential.header must not be empty");
  }

  const recordRefusal = (host: string, port: number) => {
    appendEvent(opts.recordHome, { taskId: opts.taskId, name: "network-refused", details: { host, port } });
  };

  const server = http.createServer((req, res) => {
    const gateway = opts.gateway;
    if (gateway === undefined) {
      res.writeHead(501, { "content-type": "text/plain" }).end("no gateway configured for this relay");
      return;
    }

    const headers: http.OutgoingHttpHeaders = { ...req.headers };
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

  server.on("connect", (req, clientSocket: net.Socket, head: Buffer) => {
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

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err) => reject(new RelayError("listen-failed", `relay could not bind a port: ${err instanceof Error ? err.message : String(err)}`)));
    server.listen(opts.port ?? 0, opts.bindAddress ?? "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new RelayError("listen-failed", "relay listened but reported no port");
  }

  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
