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
// from node_modules (see container/bootstrap.mjs).
//
// NOTHING IN THIS FILE MAY THROW ON A REQUEST PATH. Every handler below
// runs on an event callback, never on a path anyone awaits, so a throw
// here is an uncaught exception that exits the process - and a relay
// that exits has not failed one request, it has silently cut the network
// out from under a worker that goes on running for minutes before it
// notices (observed on 2026-10-18: a refused `registry.npmjs.org`
// tunnel, then four minutes of heartbeats, then the worker's own
// `ConnectionRefused`). Two independent faults did exactly that - a
// refused CONNECT whose client reset the socket before any `error`
// listener was attached to it, and a record append that threw straight
// out of the same handler. Hence: an `error` listener on every socket
// before anything is written to it, both top-level handlers wrapped, a
// permanent `error` listener on the server itself, and - because
// recording was one of the two faults - no file path and no record
// writing anywhere in here at all. Refusals leave through `onRefusal`
// (container/entrypoint.mjs prints them on stdout; container/launch.ts
// appends the event on the host, where a failure is harmless), and a
// reporting failure is logged and dropped: serving never depends on
// recording.

import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import { isAllowedTarget } from "./allowlist.mjs";
import { DEFAULT_MAX_CALLS_PER_TASK, DEFAULT_MAX_REQUEST_BYTES } from "./limits.mjs";
import { RelayError } from "./errors.mjs";

/** @typedef {import("./types.ts").RelayOptions} RelayOptions */
/** @typedef {import("./types.ts").RelayHandle} RelayHandle */
/** @typedef {import("./types.ts").ObservedHeaders} ObservedHeaders */

/** One line on the relay's own log - its stderr, which `docker logs`
 * carries out of the container. The only reporting channel that is
 * allowed to be the last resort, so it is itself guarded: a closed or
 * full stderr must not become the thing that kills the relay either.
 * @param {string} message */
function logProblem(message) {
  try {
    console.error(`fabrica-relay: ${message}`);
  } catch {
    // Nothing left to report with - drop it and keep serving.
  }
}

/** @param {unknown} err */
function describe(err) {
  return err instanceof Error ? err.message : String(err);
}

/** Makes a socket safe to write to and forget: an `error` with no
 * listener is an uncaught exception, and a socket this relay has already
 * answered (a 403'd CONNECT, say) is routinely reset by the client that
 * asked. Attached before the first byte is written, on every path.
 * @param {net.Socket} socket */
function ignoreErrorsOn(socket) {
  socket.on("error", () => {});
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

  /** Hands one refusal to whoever is listening - never writes it
   * anywhere itself. A throwing listener is logged and dropped: a
   * refusal that cannot be reported costs the record one line, while a
   * relay that exits over it costs the task everything.
   * @param {string} host
   * @param {number} port
   * @param {Record<string, unknown>} [extra]
   */
  const reportRefusal = (host, port, extra) => {
    try {
      opts.onRefusal?.({ host, port, ...extra });
    } catch (err) {
      logProblem(`could not report the refusal of ${host}:${port}: ${describe(err)}`);
    }
  };

  // Issue #189: the names of the response headers this relay watches,
  // lowercased once here so every response is a plain map lookup rather
  // than a case-insensitive scan, and the last values reported - a
  // reading is only reported when one of them actually changed (see
  // RelayOptions.observedResponseHeaders).
  const watchedHeaders = (opts.observedResponseHeaders ?? []).map((name) => name.toLowerCase());
  /** @type {ObservedHeaders} */
  let lastObserved = {};

  /** Reports this response's watched headers, if any of them moved.
   * Never throws: this runs on the upstream response's own event
   * callback, where a throw exits the relay and silently takes the
   * worker's network with it (see this file's header).
   * @param {import("node:http").IncomingHttpHeaders} headers */
  const reportObservedHeaders = (headers) => {
    try {
      if (watchedHeaders.length === 0 || opts.onObservedHeaders === undefined) return;
      /** @type {ObservedHeaders} */
      const observed = {};
      for (const name of watchedHeaders) {
        const value = headers[name];
        // A repeated header arrives as an array; nothing watched here is
        // repeatable, and joining is a more honest reading than picking
        // one silently.
        if (typeof value === "string") observed[name] = value;
        else if (Array.isArray(value)) observed[name] = value.join(", ");
      }
      const names = Object.keys(observed);
      if (names.length === 0) return;
      const changed =
        names.length !== Object.keys(lastObserved).length || names.some((name) => lastObserved[name] !== observed[name]);
      if (!changed) return;
      lastObserved = observed;
      opts.onObservedHeaders(observed);
    } catch (err) {
      logProblem(`could not report observed response headers: ${describe(err)}`);
    }
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
      reportRefusal(host, port, { limit: "calls-per-task", maxCallsPerTask, calls });
    }
    return true;
  };

  /** @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res */
  const handleGatewayRequest = (req, res) => {
    // Both ends of this one request, before anything is written to
    // either: a worker that abandons a request mid-body (its own process
    // exiting, the CLI timing out) otherwise surfaces as an unhandled
    // `error` on one of these. Per-request objects, deliberately not
    // `req.socket` - a keep-alive connection serves many requests, so a
    // listener per request on the shared socket would pile up (Node
    // warns past ten), and the http server already owns its sockets'
    // errors itself. A CONNECT socket is the opposite case: that one is
    // handed to the listener outright, which is why handleTunnel below
    // has to guard it.
    req.on("error", () => {});
    res.on("error", () => {});

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
      reportRefusal(gateway.host, gatewayPort, { limit: "request-size", maxRequestBytes, requestBytes: declaredLength });
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
        upstreamRes.on("error", () => {});
        // Before the response is forwarded, so a client that resets the
        // connection the instant it has its headers cannot cost the
        // reading. Forwarded untouched either way: this reads, it never
        // strips or rewrites a response header.
        reportObservedHeaders(upstreamRes.headers);
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
      reportRefusal(gateway.host, gatewayPort, { limit: "request-size", maxRequestBytes, requestBytes: forwarded });
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
  };

  /** @param {http.IncomingMessage} req
   * @param {net.Socket} clientSocket
   * @param {Buffer} head */
  const handleTunnel = (req, clientSocket, head) => {
    // FIRST, before any branch below can write to this socket: a refused
    // CONNECT is routinely answered by the client resetting the
    // connection, and an `error` with no listener here exits the relay
    // (reproduced 2026-10-18 - this one line is the crash the whole
    // incident came down to). The allowed path below adds a second
    // listener that also tears the upstream leg down; both run, and
    // what matters here is that at least one is attached on every path,
    // including the ones that answer and return immediately.
    ignoreErrorsOn(clientSocket);

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
      reportRefusal(target.host, target.port);
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
  };

  // Both handlers are wrapped rather than registered directly: whatever
  // unanticipated thing throws inside one of them costs that single
  // call, never the listener every later call depends on. The relay has
  // already been killed twice by a throw on a refusal path; this is the
  // backstop that makes a third one impossible rather than merely
  // unlikely.
  const server = http.createServer((req, res) => {
    try {
      handleGatewayRequest(req, res);
    } catch (err) {
      logProblem(`gateway request ${req.method ?? "?"} ${req.url ?? "?"} failed inside the relay: ${describe(err)}`);
      try {
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
        res.end("relay: internal error");
      } catch {
        // The response is already gone - nothing to answer with.
      }
    }
  });

  server.on("connect", (req, /** @type {net.Socket} */ clientSocket, /** @type {Buffer} */ head) => {
    try {
      handleTunnel(req, clientSocket, head);
    } catch (err) {
      logProblem(`CONNECT ${req.url ?? "?"} failed inside the relay: ${describe(err)}`);
      try {
        clientSocket.end("HTTP/1.1 500 Internal Server Error\r\n\r\n");
      } catch {
        // Same - the socket is already unusable.
      }
    }
  });

  await /** @type {Promise<void>} */ (
    new Promise((resolve, reject) => {
      server.once("error", (err) => reject(new RelayError("listen-failed", `relay could not bind a port: ${err instanceof Error ? err.message : String(err)}`)));
      server.listen(opts.port ?? 0, opts.bindAddress ?? "127.0.0.1", () => resolve());
    })
  );

  // The bind-time listener above is a `once`, consumed by now. A server
  // `error` past that point (an accept failing, a socket error Node
  // routes here) would otherwise be an uncaught exception, which for
  // this process means the worker it serves loses the network without
  // being told.
  server.on("error", (err) => logProblem(`listener error: ${describe(err)}`));

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
