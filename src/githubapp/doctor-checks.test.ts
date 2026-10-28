// `fabrica doctor`'s GitHub App line. Every probe is faked - a stub
// GitHub and a throwaway record home - so the default `npm test` run
// needs no registered App, no private key beyond one generated here,
// and no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_ID_VAR, APP_KEY_VAR } from "./config.ts";
import { githubAppStatus } from "./doctor-checks.ts";
import { PUBLISH_PERMISSIONS } from "./scopes.ts";
import { startStubGithub, type StubGithub, type StubGithubOptions } from "./helpers/stub-github.ts";
import { testKeyPair } from "./helpers/test-key.ts";

const APP_ID = "Iv1.stub";
const KEYS = testKeyPair();
const WIDGETS = { name: "widgets", owner: "acme", repo: "widgets" };
const VAULT = { name: "vault", owner: "acme", repo: "vault" };

async function stub(overrides: Partial<StubGithubOptions> = {}): Promise<StubGithub> {
  return startStubGithub({
    publicKeyPem: KEYS.publicKeyPem,
    appId: APP_ID,
    installations: { 7: ["acme/widgets"] },
    ...overrides,
  });
}

/** A record home with a usable key on disk, and the environment that
 * points at it. */
function configured(): { recordHome: string; env: NodeJS.ProcessEnv } {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-gh-app-doctor-"));
  const keyPath = join(recordHome, "key.pem");
  writeFileSync(keyPath, KEYS.privateKeyPem);
  chmodSync(keyPath, 0o600);
  return { recordHome, env: { [APP_ID_VAR]: APP_ID, [APP_KEY_VAR]: keyPath } };
}

test("configured, key accepted, installed on every registered project: OK, naming the App", async () => {
  const github = await stub();
  const { recordHome, env } = configured();
  try {
    const check = await githubAppStatus(env, recordHome, [WIDGETS], { apiRoot: github.baseUrl });

    assert.equal(check.ok, true);
    assert.equal(check.label, "github app");
    assert.match(check.detail, /fabrica-stub/);
    assert.match(check.detail, /1 installation/);
    assert.equal(check.note, undefined);
  } finally {
    await github.close();
  }
});

test("no App configured at all: FAIL in one line, with the setup as the fix", async () => {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-gh-app-doctor-none-"));

  const check = await githubAppStatus({}, recordHome, []);

  assert.equal(check.ok, false);
  // One line: a doctor line sits beside a dozen others, so the numbered
  // steps belong in the refusal a task prints, not here.
  assert.ok(!check.detail.includes("\n"), `the detail spanned lines: ${check.detail}`);
  assert.match(check.detail, /No GitHub App is configured/);
  assert.match(check.fix ?? "", /register a GitHub App/);
});

test("a key at the wrong mode: FAIL naming the mode, never the key", async () => {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-gh-app-doctor-mode-"));
  const keyPath = join(recordHome, "key.pem");
  writeFileSync(keyPath, KEYS.privateKeyPem);
  chmodSync(keyPath, 0o644);

  const check = await githubAppStatus({ [APP_ID_VAR]: APP_ID, [APP_KEY_VAR]: keyPath }, recordHome, []);

  assert.equal(check.ok, false);
  assert.match(check.detail, /mode 644/);
  assert.ok(!JSON.stringify(check).includes(KEYS.privateKeyPem.split("\n")[1]));
});

test("a key GitHub rejects: FAIL, and the App is never reported as installed", async () => {
  const github = await stub({ force: { "/app": { status: 401, body: JSON.stringify({ message: "Bad credentials" }) } } });
  const { recordHome, env } = configured();
  try {
    const check = await githubAppStatus(env, recordHome, [WIDGETS], { apiRoot: github.baseUrl });

    assert.equal(check.ok, false);
    assert.match(check.detail, /rejected/);
    assert.ok(!github.requests.some((r) => r.path.endsWith("/installation")), "it asked about a project anyway");
  } finally {
    await github.close();
  }
});

test("registered but installed nowhere: FAIL, with Install App as the fix", async () => {
  const github = await stub({ installations: {}, installationsCount: 0 });
  const { recordHome, env } = configured();
  try {
    const check = await githubAppStatus(env, recordHome, [], { apiRoot: github.baseUrl });

    assert.equal(check.ok, false);
    assert.match(check.detail, /not installed on any account/);
    assert.match(check.fix ?? "", /Install App/);
  } finally {
    await github.close();
  }
});

test("installed, but not on a registered project's repository: FAIL naming that project", async () => {
  const github = await stub();
  const { recordHome, env } = configured();
  try {
    const check = await githubAppStatus(env, recordHome, [WIDGETS, VAULT], { apiRoot: github.baseUrl });

    assert.equal(check.ok, false);
    assert.match(check.detail, /vault \(acme\/vault\)/);
    assert.doesNotMatch(check.detail, /widgets \(acme\/widgets\)/);
    assert.match(check.fix ?? "", /Configure/);
  } finally {
    await github.close();
  }
});

test("a leftover personal token is a note on a passing check, not a failure", async () => {
  const github = await stub();
  const { recordHome, env } = configured();
  try {
    const check = await githubAppStatus({ ...env, GITHUB_TOKEN: "ghp_fake" }, recordHome, [WIDGETS], {
      apiRoot: github.baseUrl,
    });

    // Nothing reads it any more, so it cannot break a task - but a
    // credential nothing uses is a credential to revoke.
    assert.equal(check.ok, true);
    assert.match(check.note ?? "", /personal GITHUB_TOKEN is still configured in the environment/);
    assert.match(check.note ?? "", /revoke/);
    assert.ok(!JSON.stringify(check).includes("ghp_fake"));
  } finally {
    await github.close();
  }
});

test("a project this machine could not ask about is a note, never reported as not installed", async () => {
  const github = await stub({
    force: { "/repos/acme/vault/installation": { status: 503, body: JSON.stringify({ message: "unavailable" }) } },
  });
  const { recordHome, env } = configured();
  try {
    const check = await githubAppStatus(env, recordHome, [WIDGETS, VAULT], { apiRoot: github.baseUrl });

    // Sending the Client to install an App that is already installed is
    // worse than saying the question could not be asked.
    assert.equal(check.ok, true);
    assert.match(check.note ?? "", /could not check vault/);
  } finally {
    await github.close();
  }
});

test("no registered project has a github.com origin: still OK, and it says so", async () => {
  const github = await stub();
  const { recordHome, env } = configured();
  try {
    const check = await githubAppStatus(env, recordHome, [], { apiRoot: github.baseUrl });

    assert.equal(check.ok, true);
    assert.match(check.detail, /no registered project has a github.com origin/);
    // Nothing to mint for, so nothing was minted - a machine with no
    // GitHub-backed project never makes this call.
    assert.equal(github.granted.length, 0);
  } finally {
    await github.close();
  }
});

// --- Issue #304: the publishing token's own granted permissions --------

test("a publish token GitHub would mint is proof, not the installation lookup: one mint per project", async () => {
  const github = await stub({ installations: { 7: ["acme/widgets", "acme/vault"] } });
  const { recordHome, env } = configured();
  try {
    const check = await githubAppStatus(env, recordHome, [WIDGETS, VAULT], { apiRoot: github.baseUrl });

    assert.equal(check.ok, true);
    assert.equal(github.granted.length, 2);
    // Exactly the publishing scope, one repository at a time - a
    // preflight must never mint something wider than the thing it is
    // checking.
    for (const grant of github.granted) {
      assert.deepEqual(grant.permissions, { ...PUBLISH_PERMISSIONS });
      assert.equal(grant.repositories.length, 1);
    }
    assert.match(check.detail, /publishing token carries every permission a handoff needs/);
  } finally {
    await github.close();
  }
});

test("the 2026-10-27 failure: a token minted without statuses: write is a FAIL naming the setting", async () => {
  const github = await stub({
    appPermissions: { contents: "write", pull_requests: "write" },
    narrowSilently: true,
  });
  const { recordHome, env } = configured();
  try {
    const check = await githubAppStatus(env, recordHome, [WIDGETS], { apiRoot: github.baseUrl });

    assert.equal(check.ok, false);
    assert.match(check.detail, /widgets/);
    assert.match(check.detail, /statuses: write/);
    // One line, like every other doctor line.
    assert.ok(!check.detail.includes("\n"), `the detail spanned lines: ${check.detail}`);
    // The exact App setting to change, plus the half nobody remembers.
    assert.match(check.fix ?? "", /Permissions & events -> Repository permissions -> Commit statuses -> Read and write/);
    assert.match(check.fix ?? "", /accept the permission change on the installation/);
  } finally {
    await github.close();
  }
});

test("a permission narrowed to read-only is a FAIL too, saying what was granted", async () => {
  const github = await stub({
    appPermissions: { contents: "write", pull_requests: "write", statuses: "read" },
  });
  const { recordHome, env } = configured();
  try {
    const check = await githubAppStatus(env, recordHome, [WIDGETS], { apiRoot: github.baseUrl });

    assert.equal(check.ok, false);
    assert.match(check.detail, /granted read/);
  } finally {
    await github.close();
  }
});

test("not installed on a project outranks a short grant: the install step comes first", async () => {
  // A repository the App does not cover cannot be asked about at all,
  // so its permissions are the same finding one step further on - and
  // sending the Client to a permissions page he cannot act on yet would
  // waste the trip.
  const github = await stub({
    installations: { 7: ["acme/widgets"] },
    appPermissions: { contents: "write", pull_requests: "write" },
    narrowSilently: true,
  });
  const { recordHome, env } = configured();
  try {
    const check = await githubAppStatus(env, recordHome, [WIDGETS, VAULT], { apiRoot: github.baseUrl });

    assert.equal(check.ok, false);
    assert.match(check.detail, /not on vault \(acme\/vault\)/);
    assert.match(check.fix ?? "", /Configure/);
  } finally {
    await github.close();
  }
});

test("two projects short of the same permission get one fix line, not two", async () => {
  const github = await stub({
    installations: { 7: ["acme/widgets", "acme/vault"] },
    appPermissions: { contents: "write", pull_requests: "write" },
    narrowSilently: true,
  });
  const { recordHome, env } = configured();
  try {
    const check = await githubAppStatus(env, recordHome, [WIDGETS, VAULT], { apiRoot: github.baseUrl });

    assert.equal(check.ok, false);
    // Both named, since what an installation accepted is per
    // installation and two accounts can disagree.
    assert.match(check.detail, /widgets/);
    assert.match(check.detail, /vault/);
    assert.equal((check.fix ?? "").match(/Commit statuses -> Read and write/g)?.length, 1);
  } finally {
    await github.close();
  }
});

test("no minted token ever reaches the check's own words", async () => {
  const github = await stub({
    appPermissions: { contents: "write", pull_requests: "write" },
    narrowSilently: true,
  });
  const { recordHome, env } = configured();
  try {
    const check = await githubAppStatus(env, recordHome, [WIDGETS], { apiRoot: github.baseUrl });

    for (const grant of github.granted) {
      assert.ok(!JSON.stringify(check).includes(grant.token), "the check carried a minted token");
    }
  } finally {
    await github.close();
  }
});
