// "Can this machine publish to this repository?", answered against a
// stub GitHub that behaves both of the ways the real one does when a
// mint asks for more than the App holds (issue #304).

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_ID_VAR, APP_KEY_VAR } from "./config.ts";
import { GithubAppError } from "./errors.ts";
import { defaultTokenMinter } from "./minter.ts";
import { publishPermissionGap } from "./publish-permissions.ts";
import { PUBLISH_PERMISSIONS } from "./scopes.ts";
import { startStubGithub, type StubGithub, type StubGithubOptions } from "./helpers/stub-github.ts";
import { testKeyPair } from "./helpers/test-key.ts";
import { fakeMinter } from "./helpers/fake-minter.ts";

const APP_ID = "Iv1.stub";
const KEYS = testKeyPair();

async function stub(overrides: Partial<StubGithubOptions> = {}): Promise<StubGithub> {
  return startStubGithub({
    publicKeyPem: KEYS.publicKeyPem,
    appId: APP_ID,
    installations: { 7: ["acme/widgets"] },
    ...overrides,
  });
}

/** A record home with a usable key on disk, and the minter that reads
 * it - the real one, so what is tested is the real mint. */
function minterAgainst(baseUrl: string) {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-publish-perms-"));
  const keyPath = join(recordHome, "key.pem");
  writeFileSync(keyPath, KEYS.privateKeyPem);
  chmodSync(keyPath, 0o600);
  return defaultTokenMinter({
    recordHome,
    env: { [APP_ID_VAR]: APP_ID, [APP_KEY_VAR]: keyPath },
    apiRoot: baseUrl,
  });
}

test("an App holding everything publishing needs: no gap", async () => {
  const github = await stub({ appPermissions: { ...PUBLISH_PERMISSIONS } });
  try {
    assert.equal(await publishPermissionGap(minterAgainst(github.baseUrl), "acme", "widgets"), null);
    // The mint really happened - a check that answers "fine" without
    // asking GitHub anything is the check this issue replaces.
    assert.equal(github.granted.length, 1);
  } finally {
    await github.close();
  }
});

test("the 2026-10-27 shape: GitHub mints, silently leaves statuses off, and the gap names it", async () => {
  const github = await stub({
    appPermissions: { contents: "write", pull_requests: "write" },
    narrowSilently: true,
  });
  try {
    const gap = await publishPermissionGap(minterAgainst(github.baseUrl), "acme", "widgets");

    assert.ok(gap !== null, "a token missing statuses: write read as fine");
    assert.deepEqual(gap.missing, [{ key: "statuses", asked: "write", granted: null }]);
    assert.equal(gap.owner, "acme");
    assert.equal(gap.repo, "widgets");
    assert.match(gap.detail, /acme\/widgets/);
    assert.match(gap.detail, /statuses: write/);
    assert.match(gap.fix, /Commit statuses -> Read and write/);
  } finally {
    await github.close();
  }
});

test("a permission narrowed from write to read is a gap too", async () => {
  const github = await stub({
    appPermissions: { contents: "write", pull_requests: "write", statuses: "read" },
  });
  try {
    const gap = await publishPermissionGap(minterAgainst(github.baseUrl), "acme", "widgets");

    assert.ok(gap !== null);
    assert.deepEqual(gap.missing, [{ key: "statuses", asked: "write", granted: "read" }]);
  } finally {
    await github.close();
  }
});

test("GitHub's other answer - a 422 refusal - is raised, never reported as a gap", async () => {
  // Both answers mean the same thing to the Client, but only one of them
  // is Fabrica's own finding; the 422 already carries GitHub's own
  // explanation and mint.ts's fix, and must not be reworded here.
  const github = await stub({ appPermissions: { contents: "write" } });
  try {
    await assert.rejects(
      () => publishPermissionGap(minterAgainst(github.baseUrl), "acme", "widgets"),
      (err: unknown) => err instanceof GithubAppError && err.code === "mint-refused"
    );
  } finally {
    await github.close();
  }
});

test("a repository the App is not installed on raises app-not-installed, not a gap", async () => {
  const github = await stub({ installations: { 7: ["someone-else/thing"] } });
  try {
    await assert.rejects(
      () => publishPermissionGap(minterAgainst(github.baseUrl), "acme", "widgets"),
      (err: unknown) => err instanceof GithubAppError && err.code === "app-not-installed"
    );
  } finally {
    await github.close();
  }
});

test("the minted token is never part of what comes back", async () => {
  const minter = fakeMinter({ token: "ghs-secret-under-test", granted: { contents: "write" } });

  const gap = await publishPermissionGap(minter, "acme", "widgets");

  assert.ok(gap !== null);
  assert.ok(!JSON.stringify(gap).includes("ghs-secret-under-test"), "the gap carried the token");
  // And exactly the publish scope was asked for - one repository, three
  // permissions.
  assert.deepEqual(minter.calls, [
    { purpose: "publish", scope: { owner: "acme", repo: "widgets", permissions: PUBLISH_PERMISSIONS } },
  ]);
});
