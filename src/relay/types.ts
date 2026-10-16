// The shapes this module's own functions take and return. Nothing here
// is shared with contract/surface.ts except FabricaEventName's new
// "network-refused" member (declared there, imported as a type) - a
// relay's own configuration is plumbing, not a promise to the Client.

/** One host this task's traffic may reach, matched against a CONNECT
 * target's hostname or a request's declared destination - never a
 * resolved IP, so a host that later resolves somewhere else is still
 * judged by the name the caller asked for. A leading "*." matches any
 * single label of subdomains (e.g. "*.github.com" matches
 * "api.github.com" but not "github.com" itself - list both if both are
 * needed). `port` restricts the entry to one destination port; omitted
 * matches any port. */
export interface AllowedHost {
  host: string;
  port?: number;
}

/** How a per-task fake credential is swapped for the real one on its
 * way to the gateway's one upstream (below). The worker is handed
 * `fakeValue` and never sees `realValue` - the relay is the only place
 * that holds both. */
export interface CredentialSwap {
  /** The header name the swap applies to, e.g. "authorization". Matched
   * case-insensitively, the way HTTP headers already are. */
  header: string;
  /** What the worker is configured with. Recorded only so a test can
   * prove it never reaches the real upstream - the relay does not
   * validate that an incoming request actually carries this value
   * before swapping; it always sets the real one, since the worker has
   * no other value to send. */
  fakeValue: string;
  /** What the relay substitutes before forwarding upstream. Never
   * logged, never put on the record. */
  realValue: string;
}

/** The one fixed upstream every non-CONNECT request reaching this relay
 * is forwarded to, credential swapped in (issue #186: "swaps a per-task
 * fake key for the real one"). There is exactly one per relay - a
 * worker's HTTP client is pointed at the relay itself (its base URL
 * replaced), not told to negotiate a destination per request, so there
 * is nothing to route on. */
export interface GatewayTarget {
  host: string;
  /** Defaults to 443. */
  port?: number;
  /** Defaults to true - the relay's own outbound leg to the real
   * upstream is real TLS; only the worker-to-relay leg, confined to a
   * network nothing outside this task can reach, is not. */
  tls?: boolean;
  credential?: CredentialSwap;
}

export interface RelayOptions {
  recordHome: string;
  taskId: string;
  /** Host-side port to listen on. Omitted (the default, 0) asks the OS
   * for any free port - read back from the returned handle. A caller
   * that needs the same port across a restart (none do yet) can pin
   * one. */
  port?: number;
  /** Address to bind the listener to. Defaults to "127.0.0.1" (same-
   * process/same-host callers, e.g. this module's own fast tests). A
   * worker box reaches the relay from inside its own isolated Docker
   * network (`src/containment/isolated-network.ts`), so a real
   * deployment binds this to that network's gateway IP instead - the
   * one address a container on that network can actually route to. */
  bindAddress?: string;
  /** CONNECT-tunnel-eligible hosts (issue #186: "a short fixed list of
   * allowed hosts") - raw bytes pass through untouched once a target
   * matches; nothing here can see or alter what rides inside the
   * tunnel. A CONNECT target that matches none of these is refused and
   * recorded (see `onRefusal` / the "network-refused" event). */
  tunnelAllowlist: AllowedHost[];
  /** The gateway's one upstream. Omit to run tunnel-only (no credential
   * swap at all) - every non-CONNECT request then gets a plain 501,
   * since there is nowhere configured to send it. */
  gateway?: GatewayTarget;
}

export interface RelayHandle {
  /** The host-side port the relay is listening on - point a worker's
   * HTTP_PROXY/HTTPS_PROXY (tunnel traffic) and its gateway base URL
   * (credential-swapped traffic) at this, on whatever address the
   * worker's network can actually reach (see isolated-network.ts). */
  readonly port: number;
  close(): Promise<void>;
}
