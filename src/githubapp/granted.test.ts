// The comparison issue #304 rests on: what a mint asked for against what
// GitHub says it granted. No network and no App - this is arithmetic over
// two maps, plus the words both surfaces read out of it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeMissingPermissions,
  grantPermissionsFix,
  missingPermissions,
  settingLevelFor,
  settingNameFor,
} from "./granted.ts";
import { appSetupSteps } from "./config.ts";
import { PUBLISH_PERMISSIONS, READ_CHECKS_PERMISSIONS, READ_ISSUE_PERMISSIONS } from "./scopes.ts";
import type { AppPermission } from "./types.ts";

test("a grant carrying everything asked for is short of nothing", () => {
  assert.deepEqual(missingPermissions(PUBLISH_PERMISSIONS, { ...PUBLISH_PERMISSIONS }), []);
});

test("the 2026-10-27 failure: statuses missing from the grant entirely", () => {
  const missing = missingPermissions(PUBLISH_PERMISSIONS, { contents: "write", pull_requests: "write" });

  assert.deepEqual(missing, [{ key: "statuses", asked: "write", granted: null }]);
});

test("a grant narrowed from write to read is short, and says what it got", () => {
  const missing = missingPermissions(PUBLISH_PERMISSIONS, {
    contents: "write",
    pull_requests: "write",
    statuses: "read",
  });

  assert.deepEqual(missing, [{ key: "statuses", asked: "write", granted: "read" }]);
});

test("a grant wider than asked for is not a shortfall", () => {
  // Compared by rank, not equality: `admin` can be held where `write`
  // was asked, and `write` where `read` was.
  assert.deepEqual(missingPermissions(READ_ISSUE_PERMISSIONS, { issues: "write" }), []);
  assert.deepEqual(missingPermissions(PUBLISH_PERMISSIONS, { contents: "admin", pull_requests: "admin", statuses: "admin" }), []);
});

test("a level GitHub does not use reads as no grant at all, never as enough", () => {
  assert.deepEqual(missingPermissions(READ_ISSUE_PERMISSIONS, { issues: "maintain" }), [
    { key: "issues", asked: "read", granted: "maintain" },
  ]);
});

test("permissions the scope never asked for are not compared", () => {
  // GitHub grants `metadata: read` to every installation token
  // implicitly, so it is on every grant and in no Fabrica scope.
  assert.deepEqual(missingPermissions(READ_ISSUE_PERMISSIONS, { issues: "read", metadata: "read" }), []);
});

test("several shortfalls come back sorted, so the same state always reads the same", () => {
  const missing = missingPermissions(READ_CHECKS_PERMISSIONS, { pull_requests: "read" });

  assert.deepEqual(
    missing.map((entry) => entry.key),
    ["actions", "checks", "statuses"]
  );
});

test("the shortfall phrase names the key, the level asked for, and what came back", () => {
  const phrase = describeMissingPermissions([
    { key: "contents", asked: "write", granted: "read" },
    { key: "statuses", asked: "write", granted: null },
  ]);

  assert.equal(phrase, "contents: write (granted read), statuses: write (not granted at all)");
});

test("the fix names the settings page's own path, label and level, plus accepting on the installation", () => {
  const fix = grantPermissionsFix([{ key: "statuses", asked: "write", granted: null }]);

  // Exactly the route the issue asks for, in the App settings page's own
  // words rather than the API's.
  assert.match(fix, /Permissions & events -> Repository permissions -> Commit statuses -> Read and write/);
  assert.match(fix, /accept the permission change on the installation/);
  assert.doesNotMatch(fix, /statuses: write/);
});

test("the fix lists every short setting when more than one is", () => {
  const fix = grantPermissionsFix([
    { key: "contents", asked: "write", granted: "read" },
    { key: "actions", asked: "read", granted: null },
  ]);

  assert.match(fix, /Contents -> Read and write/);
  assert.match(fix, /Actions -> Read-only/);
});

test("a permission key with no settings-page name falls back to the key, never to a guess", () => {
  assert.equal(settingNameFor("statuses"), "Commit statuses");
  assert.equal(settingNameFor("pull_requests"), "Pull requests");
  assert.equal(settingNameFor("single_file"), "single_file");
  assert.equal(settingLevelFor("write"), "Read and write");
  assert.equal(settingLevelFor("read"), "Read-only");
});

test("the setup steps grant every permission Fabrica's own scopes ask for at write", () => {
  // The root cause of issue #304 was here, not in the code: these steps
  // said "Commit statuses: Read-only" while PUBLISH_PERMISSIONS has
  // asked for `statuses: write` since the handoff that first answered
  // 403 on the stamp, and nothing compared the two. This is that
  // comparison.
  const steps = appSetupSteps("/home/someone/.fabrica");
  const asked: Record<string, AppPermission> = {
    ...PUBLISH_PERMISSIONS,
    ...READ_ISSUE_PERMISSIONS,
    ...READ_CHECKS_PERMISSIONS,
  };
  // A read and a write of the same key: the write wins, which is what
  // the Client has to grant.
  for (const key of Object.keys(asked)) {
    if (PUBLISH_PERMISSIONS[key] === "write") asked[key] = "write";
  }

  for (const [key, level] of Object.entries(asked)) {
    assert.match(
      steps,
      new RegExp(`${settingNameFor(key)}: ${settingLevelFor(level)}`),
      `the setup steps do not tell the Client to grant ${settingNameFor(key)}: ${settingLevelFor(level)}`
    );
  }
});
