// Which hosts a task's worker box may reach, and under which limits
// (issue #186, second half). Two pure functions, no I/O: the Foreman
// reads a project's own declaration out of projects.toml
// (src/foreman/network-policy.ts) and an adapter composes it with
// whatever its own base hosts are, right before starting that task's
// relay.
//
// What this module deliberately does NOT know is which hosts those base
// ones are. The model provider's own host is adapter-only knowledge
// (CONTRACT rule 8, "No favorite brain"), so it arrives as a parameter;
// GitHub, being a destination rather than a brain, is named in
// allowlist.mjs and composed in by the caller alongside it.

import { RelayError } from "./errors.mjs";
import { DEFAULT_MAX_CALLS_PER_TASK, DEFAULT_MAX_REQUEST_BYTES } from "./limits.mjs";
import type { AllowedHost } from "./types.ts";

/** What a project declared in projects.toml, as the relay needs it -
 * `src/config`'s ProjectConfig narrowed to the network fields, so
 * nothing here depends on the config loader. Every field is optional:
 * a project that declares nothing gets the base hosts and the default
 * limits. */
export interface DeclaredNetwork {
  hosts?: readonly string[];
  maxRequestBytes?: number;
  maxCallsPerTask?: number;
}

/** One projects.toml `hosts` entry as the allowlist matcher wants it.
 * `"example.com"` matches that host on any port; `"example.com:8443"`
 * restricts it to that port; `"*.example.com"` matches one level of
 * subdomain (allowlist.mjs owns the matching itself).
 *
 * Throws `RelayError("invalid-config")` rather than quietly returning
 * an entry that can never match: a typo in a Client's own config file
 * must announce itself, and the one caller (an adapter starting a
 * task's relay) already turns this into a plain refusal naming the
 * file. */
export function parseAllowedHost(spec: string): AllowedHost {
  const trimmed = spec.trim();
  const colon = trimmed.lastIndexOf(":");
  if (colon === -1) {
    if (trimmed.length === 0) throw new RelayError("invalid-config", "an allowed host in projects.toml is empty");
    return { host: trimmed };
  }

  const host = trimmed.slice(0, colon);
  const portText = trimmed.slice(colon + 1);
  const port = Number(portText);
  if (host.length === 0 || !/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RelayError(
      "invalid-config",
      `"${spec}" is not a host projects.toml can allow: write a host name ("example.com"), ` +
        `optionally with one port ("example.com:8443"), optionally with a leading "*." for subdomains`
    );
  }
  return { host, port };
}

/** The tunnel allowlist for one task: the caller's own base hosts plus
 * whatever the project declared, in that order.
 *
 * Additive on purpose (Client ruling, issue #186): a project's list is
 * added to the base hosts, never a replacement for them, so declaring
 * `hosts = ["registry.npmjs.org"]` cannot accidentally cut the worker
 * off from the model provider or from GitHub. A project that declares
 * nothing gets exactly the base hosts. */
export function tunnelAllowlistFor(baseHosts: readonly AllowedHost[], declared?: DeclaredNetwork): AllowedHost[] {
  return [...baseHosts, ...(declared?.hosts ?? []).map(parseAllowedHost)];
}

/** The two limits in force for one task: the project's own numbers
 * where it set them, limits.mjs's defaults where it didn't. */
export function relayLimitsFor(declared?: DeclaredNetwork): { maxRequestBytes: number; maxCallsPerTask: number } {
  return {
    maxRequestBytes: declared?.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
    maxCallsPerTask: declared?.maxCallsPerTask ?? DEFAULT_MAX_CALLS_PER_TASK,
  };
}
