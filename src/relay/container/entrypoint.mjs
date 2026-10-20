// @ts-check
// Runs *inside* the relay's own container - never on the host, and
// never inside a worker's box. Loaded by bootstrap.mjs. Configuration
// arrives through exactly one env var, `FABRICA_RELAY_CONFIG` (JSON) -
// never argv - so a real credential never shows up in `docker run`'s own
// command line or in a host `ps` listing; launch.ts writes it through a
// throwaway `--env-file` for that reason, the same care
// src/containment/run.ts already takes for a worker's own env.

import { startRelay } from "../server.mjs";
import { HEADERS_MARKER, LISTENING_MARKER, REFUSAL_MARKER } from "./protocol.mjs";

const raw = process.env.FABRICA_RELAY_CONFIG;
if (raw === undefined) {
  console.error("fabrica-relay: FABRICA_RELAY_CONFIG is not set");
  process.exit(1);
}

/** @type {import("./types.ts").RelayContainerConfig} */
const config = JSON.parse(raw);

const relay = await startRelay({
  // This container's whole report of a refusal: one line on stdout, read
  // back on the host by launch.ts's watcher, which appends the
  // `"network-refused"` event there. Nothing in here touches the record
  // or knows where it is - a refusal that could not be written used to
  // throw out of a request handler and kill the relay, taking the
  // worker's network with it (see server.mjs's header). A failing write
  // here costs one refusal on the record and nothing else: startRelay
  // catches it and logs it.
  onRefusal: (details) => console.log(`${REFUSAL_MARKER} ${JSON.stringify(details)}`),
  // Issue #189: the same one-line-on-stdout channel, for the same
  // reason - the host side owns every decision made with this, and the
  // relay keeps no state about it beyond "what did I last say". Only the
  // headers the caller named are ever printed, never a whole response's
  // header set.
  onObservedHeaders: (headers) => console.log(`${HEADERS_MARKER} ${JSON.stringify(headers)}`),
  // 0.0.0.0, not 127.0.0.1 (startRelay's own default): the worker
  // reaching this relay is a *different* container on the isolated
  // network, never this one's own loopback.
  bindAddress: "0.0.0.0",
  port: config.port,
  tunnelAllowlist: config.tunnelAllowlist,
  gateway: config.gateway,
  maxRequestBytes: config.maxRequestBytes,
  maxCallsPerTask: config.maxCallsPerTask,
  observedResponseHeaders: config.observedResponseHeaders,
});

// launch.ts's waitForListening() watches for this exact line through
// `docker logs` - control-plane, not network traffic, so it works even
// though nothing on a Docker-Desktop host can otherwise reach this
// container directly (see launch.ts's own doc for why that's the
// mechanism, not a TCP probe).
console.log(`${LISTENING_MARKER} ${relay.port}`);

async function shutdown() {
  await relay.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
