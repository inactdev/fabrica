// Host-matching for the tunnel allowlist. Matches names, never resolved
// addresses - a CONNECT target's hostname is compared as given, the
// same thing the record's refusal event ends up naming.

import type { AllowedHost } from "./types.ts";

/** GitHub's own hosts (issue #186's fixed list: "the model provider and
 * GitHub only for now"). Generic, not brain-specific - GitHub is a
 * destination, never a brain, so this stays outside rule 8's scan on
 * purpose. The model provider's own host is never named here: only
 * `src/brain/adapters/` may say which one that is (CONTRACT rule 8), so
 * it's a caller-supplied `GatewayTarget`/extra `AllowedHost`, not a
 * constant in this module. */
export const GITHUB_HOSTS: readonly AllowedHost[] = [
  { host: "github.com" },
  { host: "*.github.com" },
];

function hostnameMatches(pattern: string, hostname: string): boolean {
  const normalizedPattern = pattern.toLowerCase();
  const normalizedHost = hostname.toLowerCase();
  if (!normalizedPattern.startsWith("*.")) return normalizedPattern === normalizedHost;
  const suffix = normalizedPattern.slice(1); // ".github.com"
  return normalizedHost.endsWith(suffix) && normalizedHost.length > suffix.length;
}

/** True when `hostname:port` is covered by some entry in `allowlist` - a
 * port-less entry matches any port; an entry naming a port matches only
 * that one. */
export function isAllowedTarget(hostname: string, port: number, allowlist: readonly AllowedHost[]): boolean {
  return allowlist.some((entry) => hostnameMatches(entry.host, hostname) && (entry.port === undefined || entry.port === port));
}
