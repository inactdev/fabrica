// Shapes shared between launch.ts (runs on the host, starts the
// container) and entrypoint.mjs (runs inside it, typed from here via
// JSDoc). Nothing here is shared
// with contract/surface.ts - same as src/relay/types.ts, this is
// plumbing, not a promise to the Client.

import type { AllowedHost, GatewayTarget } from "../types.ts";

/** The fixed port the relay always listens on inside its own container.
 * Fixed rather than OS-assigned: nothing else shares that container's
 * network namespace, so there is no port to collide with, and a fixed
 * port means the host side never has to read one back over a channel
 * that can't reach into the container anyway (see launch.ts's own
 * doc). */
export const CONTAINER_RELAY_PORT = 8090;

/** What launch.ts hands the container via `FABRICA_RELAY_CONFIG` (one
 * env var, JSON-encoded, delivered through a throwaway `--env-file` so a
 * real credential never appears in `docker run`'s own argv or in `ps` -
 * the same care `src/containment/run.ts` already takes for a worker's
 * env). entrypoint.mjs reads exactly this shape back out.
 *
 * Deliberately carries no `recordHome` and no `taskId` (2026-10-18):
 * the relay used to append its own `"network-refused"` events inside
 * this container, against a host path bind-mounted in for the purpose,
 * and a write that failed threw out of a request handler and exited the
 * relay - which silently cut the network out from under a worker that
 * ran on for minutes before noticing. Refusals now leave on stdout
 * (`protocol.mjs`'s `REFUSAL_MARKER`) and launch.ts appends them on the
 * host, so no host path is reachable from in here at all and the record
 * home is not mounted into this container. */
export interface RelayContainerConfig {
  /** Always `CONTAINER_RELAY_PORT` - carried in the config so
   * entrypoint.mjs (plain JavaScript) never imports this TypeScript
   * file at runtime. */
  port: number;
  tunnelAllowlist: AllowedHost[];
  gateway?: GatewayTarget;
  /** The two limits this task's relay enforces (src/relay/limits.mjs,
   * and RelayOptions in src/relay/types.ts) - carried through so a
   * project's own projects.toml overrides reach the relay running
   * inside the container, not only one started in-process. */
  maxRequestBytes?: number;
  maxCallsPerTask?: number;
}

export interface ContainerizedRelayOptions {
  /** Where this relay's refusals are appended - on the host side, by
   * launch.ts's own watcher, never from inside the container (see
   * `RelayContainerConfig` above). */
  recordHome: string;
  taskId: string;
  /** Name of an already-created `--internal` network (`src/containment/
   * isolated-network.ts`) - the leg this relay container shares with the
   * worker it's serving. Not created here; the caller owns its
   * lifecycle because the caller also attaches the worker to it. */
  isolatedNetwork: string;
  /** Name of an already-created plain (non-internal) network
   * (`src/containment/egress-network.ts`) - this relay container's own,
   * separate route to the real internet. The worker is never attached
   * to this one. */
  egressNetwork: string;
  tunnelAllowlist: AllowedHost[];
  gateway?: GatewayTarget;
  /** See `RelayContainerConfig` above; omitted, the relay's own
   * defaults apply. */
  maxRequestBytes?: number;
  maxCallsPerTask?: number;
  /** Defaults to `RELAY_IMAGE` (launch.ts) - overridable for tests. */
  image?: string;
  /** How long to wait for the container's own `FABRICA-RELAY-LISTENING`
   * line before giving up with `RelayError("listen-failed")`; defaults to
   * launch.ts's own 15s. Overridable so `launch.test.ts` can drive that
   * timeout path (and the container removal on it) without a real
   * 15-second wait in the fast suite. */
  listenTimeoutMs?: number;
  /** How often the host-side watcher reads the relay container's log -
   * for new refusals to append, and for the container having gone away
   * entirely. Defaults to launch.ts's own `DEFAULT_WATCH_INTERVAL_MS`;
   * a test shortens it rather than waiting a real second per poll. */
  watchIntervalMs?: number;
}

export interface ContainerizedRelayHandle {
  /** The relay's own address on `isolatedNetwork` - point a worker's
   * HTTP_PROXY/HTTPS_PROXY and gateway base URL (whatever variable an
   * adapter's own HTTP client reads - adapter-only knowledge, see
   * CONTRACT rule 8) at `http://${host}:${port}`. This is never
   * reachable from the Fabrica process itself on Docker Desktop (see
   * launch.ts) - only from another container on the same isolated
   * network - which is exactly what the worker is. */
  host: string;
  port: number;
  /** Why this relay is no longer serving, once the host-side watcher has
   * established that it isn't - a sentence naming the relay container,
   * written to be shown to the Client as the reason an attempt failed.
   * `undefined` for as long as it is serving (and after `close()`, which
   * is an expected ending, not a failure).
   *
   * Nothing restarts a dead relay: a replacement container would get a
   * new address on the isolated network while the worker's own
   * configuration still names the old one. The caller fails the attempt
   * with this instead - `src/foreman/attempts.ts`'s heartbeat is what
   * reads it, so a relay that dies costs one heartbeat interval rather
   * than the minutes a worker takes to notice its own
   * `ConnectionRefused` (observed 2026-10-18: four of them). */
  failure(): string | undefined;
  close(): Promise<void>;
}
