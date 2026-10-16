import { test } from "node:test";
import assert from "node:assert/strict";
import { GITHUB_HOSTS, isAllowedTarget } from "./allowlist.ts";

test("isAllowedTarget matches an exact host, any port, when none is named", () => {
  assert.ok(isAllowedTarget("github.com", 443, GITHUB_HOSTS));
  assert.ok(isAllowedTarget("github.com", 22, GITHUB_HOSTS));
  assert.ok(!isAllowedTarget("evil.com", 443, GITHUB_HOSTS));
});

test("isAllowedTarget's wildcard matches one level of subdomain, not the bare domain", () => {
  assert.ok(isAllowedTarget("api.github.com", 443, GITHUB_HOSTS));
  assert.ok(isAllowedTarget("raw.githubusercontent.com", 443, [{ host: "*.githubusercontent.com" }]));
  assert.ok(!isAllowedTarget("githubusercontent.com", 443, [{ host: "*.githubusercontent.com" }]));
  // A wildcard must not match a host that merely ends with the same
  // letters - "notgithub.com" is not a subdomain of "github.com".
  assert.ok(!isAllowedTarget("notgithub.com", 443, GITHUB_HOSTS));
});

test("isAllowedTarget is case-insensitive", () => {
  assert.ok(isAllowedTarget("GitHub.com", 443, GITHUB_HOSTS));
});

test("isAllowedTarget restricts to a named port, matches any port when none is named", () => {
  const scoped = [{ host: "example.com", port: 443 }];
  assert.ok(isAllowedTarget("example.com", 443, scoped));
  assert.ok(!isAllowedTarget("example.com", 22, scoped));
});

test("isAllowedTarget refuses when the allowlist is empty", () => {
  assert.ok(!isAllowedTarget("github.com", 443, []));
});
