// Pure checks on the generated Seatbelt profile text - the real proof
// that these rules actually confine a process is run.test.ts, which hands
// this exact output to `sandbox-exec` for real. This file only checks
// that buildProfile emits the rules its own reasoning depends on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProfile } from "./profile.ts";

test("buildProfile denies by default and allows workdir read+write", () => {
  const profile = buildProfile({ workdir: "/Users/ari/.fabrica/tasks/t1/worktree", homeDir: "/Users/ari", network: "denied" });

  assert.match(profile, /\(deny default\)/);
  assert.match(profile, /\(allow file-read\* \(subpath "\/Users\/ari\/\.fabrica\/tasks\/t1\/worktree"\)\)/);
  assert.match(profile, /\(allow file-write\* \(subpath "\/Users\/ari\/\.fabrica\/tasks\/t1\/worktree"\)\)/);
});

test("buildProfile excludes homeDir from the broad read allowance", () => {
  const profile = buildProfile({ workdir: "/Users/ari/.fabrica/tasks/t1/worktree", homeDir: "/Users/ari", network: "denied" });

  assert.match(profile, /require-not \(subpath "\/Users\/ari"\)/);
});

test("buildProfile omits network rules when denied, adds them when allowed", () => {
  const denied = buildProfile({ workdir: "/w", homeDir: "/h", network: "denied" });
  const allowed = buildProfile({ workdir: "/w", homeDir: "/h", network: "allowed" });

  assert.doesNotMatch(denied, /network/);
  assert.match(allowed, /\(allow network\*\)/);
  assert.match(allowed, /\(allow system-socket\)/);
});

test("buildProfile escapes double quotes and backslashes in paths", () => {
  const profile = buildProfile({ workdir: '/Users/a"b\\c', homeDir: "/h", network: "denied" });

  assert.match(profile, /\/Users\/a\\"b\\\\c/);
});
