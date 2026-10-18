// Issue #186's "a project declares its allowed hosts in projects.toml,
// and a project with none declared gets only the model hosts plus
// GitHub" - the composition half, in isolation. The base hosts stand in
// for whatever an adapter supplies (this module may not name the model
// provider's host: CONTRACT rule 8), and src/foreman/network-policy.ts
// has the other half, reading a real projects.toml.

import { test } from "node:test";
import assert from "node:assert/strict";
import { GITHUB_HOSTS } from "./allowlist.mjs";
import { DEFAULT_MAX_CALLS_PER_TASK, DEFAULT_MAX_REQUEST_BYTES } from "./limits.mjs";
import { isAllowedTarget } from "./allowlist.mjs";
import { parseAllowedHost, relayLimitsFor, tunnelAllowlistFor } from "./policy.ts";
import { RelayError } from "./errors.mjs";

const BASE = [{ host: "model.example" }, ...GITHUB_HOSTS];

test("a project that declares no hosts gets exactly the base hosts", () => {
  assert.deepEqual(tunnelAllowlistFor(BASE), [...BASE]);
  assert.deepEqual(tunnelAllowlistFor(BASE, {}), [...BASE]);
  assert.deepEqual(tunnelAllowlistFor(BASE, { hosts: [] }), [...BASE]);
});

test("a project's own hosts are added to the base hosts, never a replacement for them", () => {
  const allowlist = tunnelAllowlistFor(BASE, { hosts: ["registry.npmjs.org"] });

  assert.ok(isAllowedTarget("registry.npmjs.org", 443, allowlist), "the declared host must be reachable");
  assert.ok(isAllowedTarget("model.example", 443, allowlist), "declaring a host must not cut the model provider off");
  assert.ok(isAllowedTarget("api.github.com", 443, allowlist), "declaring a host must not cut GitHub off");
  assert.ok(!isAllowedTarget("evil.example.com", 443, allowlist), "everything else is still refused");
});

test("a declared host may name one port, or none at all", () => {
  assert.deepEqual(parseAllowedHost("example.com"), { host: "example.com" });
  assert.deepEqual(parseAllowedHost("example.com:8443"), { host: "example.com", port: 8443 });
  assert.deepEqual(parseAllowedHost("  example.com:8443  "), { host: "example.com", port: 8443 });
  assert.deepEqual(parseAllowedHost("*.example.com"), { host: "*.example.com" });

  const ported = tunnelAllowlistFor([], { hosts: ["example.com:8443"] });
  assert.ok(isAllowedTarget("example.com", 8443, ported));
  assert.ok(!isAllowedTarget("example.com", 443, ported), "a declared port restricts the entry to that port");
});

test("a host nothing could ever match is refused loudly, not accepted silently", () => {
  for (const spec of ["example.com:nope", "example.com:0", "example.com:70000", ":443"]) {
    assert.throws(
      () => parseAllowedHost(spec),
      (err: unknown) => err instanceof RelayError && err.code === "invalid-config",
      `"${spec}" should have been refused`
    );
  }
});

test("the limits are the project's own numbers where it set them, the defaults where it did not", () => {
  assert.deepEqual(relayLimitsFor(), {
    maxRequestBytes: DEFAULT_MAX_REQUEST_BYTES,
    maxCallsPerTask: DEFAULT_MAX_CALLS_PER_TASK,
  });
  assert.deepEqual(relayLimitsFor({ maxRequestBytes: 1024 }), {
    maxRequestBytes: 1024,
    maxCallsPerTask: DEFAULT_MAX_CALLS_PER_TASK,
  });
  assert.deepEqual(relayLimitsFor({ maxCallsPerTask: 3 }), {
    maxRequestBytes: DEFAULT_MAX_REQUEST_BYTES,
    maxCallsPerTask: 3,
  });
});

test("the defaults are the ones the Client was told: 10 MB per request, 2000 calls per task", () => {
  assert.equal(DEFAULT_MAX_REQUEST_BYTES, 10 * 1024 * 1024);
  assert.equal(DEFAULT_MAX_CALLS_PER_TASK, 2000);
});
