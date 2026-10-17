// @ts-check
// Runs *inside* the relay's own container - never on the host, and
// never inside a worker's box. Loaded by bootstrap.mjs. Configuration
// arrives through exactly one env var, `FABRICA_RELAY_CONFIG` (JSON) -
// never argv - so a real credential never shows up in `docker run`'s own
// command line or in a host `ps` listing; launch.ts writes it through a
// throwaway `--env-file` for that reason, the same care
// src/containment/run.ts already takes for a worker's own env.

import { startRelay } from "../server.mjs";

const raw = process.env.FABRICA_RELAY_CONFIG;
if (raw === undefined) {
  console.error("fabrica-relay: FABRICA_RELAY_CONFIG is not set");
  process.exit(1);
}

/** @type {import("./types.ts").RelayContainerConfig} */
const config = JSON.parse(raw);

const relay = await startRelay({
  recordHome: config.recordHome,
  taskId: config.taskId,
  // 0.0.0.0, not 127.0.0.1 (startRelay's own default): the worker
  // reaching this relay is a *different* container on the isolated
  // network, never this one's own loopback.
  bindAddress: "0.0.0.0",
  port: config.port,
  tunnelAllowlist: config.tunnelAllowlist,
  gateway: config.gateway,
});

// launch.ts's waitForListening() watches for this exact line through
// `docker logs` - control-plane, not network traffic, so it works even
// though nothing on a Docker-Desktop host can otherwise reach this
// container directly (see launch.ts's own doc for why that's the
// mechanism, not a TCP probe).
console.log(`FABRICA-RELAY-LISTENING ${relay.port}`);

async function shutdown() {
  await relay.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
