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

/** What a refusal says: always the host and port the worker box was
 * trying to reach; a refusal caused by one of the limits (limits.mjs)
 * additionally names which, with its numbers. Shaped as the `details` of
 * the `"network-refused"` event it becomes, since that is the only thing
 * ever done with it. */
export type RefusalDetails = Record<string, unknown>;

export interface RelayOptions {
  /** Where a refusal goes. Called with nothing else expected of it - a
   * listener that throws is logged on the relay's own stderr and
   * dropped, and a relay with no listener at all still refuses exactly
   * the same traffic, it just says so to nobody.
   *
   * The relay deliberately does NOT write the record itself any more
   * (2026-10-18): it used to append the `"network-refused"` event
   * straight to `<recordHome>/events.jsonl` from inside its own
   * container, so a record home that was missing, read-only or full
   * made a refusal throw out of a request handler and exit the
   * process - taking the worker's whole network with it. Nothing in
   * here knows a host path now. `container/entrypoint.mjs` prints
   * refusals on stdout and `container/launch.ts` appends the event on
   * the host side, where a failed write costs one log line. */
  onRefusal?: (details: RefusalDetails) => void;
  /** Host-side port to listen on. Omitted (the default, 0) asks the OS
   * for any free port - read back from the returned handle. A caller
   * that needs the same port across a restart (none do yet) can pin
   * one. */
  port?: number;
  /** Address to bind the listener to. Defaults to "127.0.0.1" (same-
   * process/same-host callers, e.g. this module's own fast tests). A
   * real deployment runs the relay itself as a container on the
   * isolated network a worker box also joins
   * (`src/relay/container/launch.ts`, `src/containment/
   * isolated-network.ts`) and binds this to "0.0.0.0" there, since the
   * worker reaching it is a different container on that same network -
   * not this process's own loopback, and (proven on Docker Desktop)
   * never the network's gateway address either. */
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
  /** The largest single request a worker box may send through gateway
   * mode, in bytes (issue #186). Defaults to `limits.mjs`'s
   * `DEFAULT_MAX_REQUEST_BYTES`; a project overrides it with
   * projects.toml's `maxRequestBytes`. Over it, that one request is
   * refused with a 413 and a `"network-refused"` event naming the
   * limit, and the task runs on - rule 10's spending cap is the only
   * thing that stops a task (Client ruling, issue #186). This
   * deliberately cannot apply to tunnel mode: a CONNECT tunnel is raw
   * bytes the relay never looks inside, so there is no request in it to
   * measure. */
  maxRequestBytes?: number;
  /** How many calls this task may make through the relay - one gateway
   * request, or one CONNECT tunnel, is one call. Defaults to
   * `limits.mjs`'s `DEFAULT_MAX_CALLS_PER_TASK`; a project overrides it
   * with projects.toml's `maxCallsPerTask`. Past it every further call
   * is refused (429), recorded once, and the task still runs on. */
  maxCallsPerTask?: number;
}

export interface RelayHandle {
  /** The host-side port the relay is listening on - point a worker's
   * HTTP_PROXY/HTTPS_PROXY (tunnel traffic) and its gateway base URL
   * (credential-swapped traffic) at this, on whatever address the
   * worker's network can actually reach (see isolated-network.ts). */
  readonly port: number;
  close(): Promise<void>;
}
