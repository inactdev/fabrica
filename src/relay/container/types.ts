// Shapes shared between launch.ts (runs on the host, starts the
// container) and entrypoint.ts (runs inside it). Nothing here is shared
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
 * env). entrypoint.ts reads exactly this shape back out. */
export interface RelayContainerConfig {
  recordHome: string;
  taskId: string;
  tunnelAllowlist: AllowedHost[];
  gateway?: GatewayTarget;
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
  /** Defaults to `RELAY_IMAGE` (launch.ts) - overridable for tests. */
  image?: string;
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
