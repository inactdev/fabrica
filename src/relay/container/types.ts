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
 * env). entrypoint.mjs reads exactly this shape back out. */
export interface RelayContainerConfig {
  recordHome: string;
  taskId: string;
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
  close(): Promise<void>;
}
