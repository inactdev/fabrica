// Where the App's credentials come from, and every refusal reading them
// can produce. Nothing here touches the network, and nothing here reads
// the real `~/.fabrica` - every test gets its own throwaway record home.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_ID_VAR,
  APP_KEY_VAR,
  appSettings,
  appSetupSteps,
  leftoverPersonalToken,
  requireAppCredentials,
  resolveKeyPath,
} from "./config.ts";
import { GithubAppError } from "./errors.ts";
import { testKeyPair } from "./helpers/test-key.ts";

function home(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-gh-app-config-"));
}

function brainEnv(dir: string, content: string, mode = 0o600): void {
  const path = join(dir, "brain.env");
  writeFileSync(path, content);
  chmodSync(path, mode);
}

/** A real, throwaway PKCS#1 key on disk at the mode the Client is told
 * to set. Returns the path and the PEM, so a test can assert the PEM
 * reached the caller unchanged. */
function keyFile(dir: string, name = "github-app.pem", mode = 0o600): { path: string; pem: string } {
  const { privateKeyPem } = testKeyPair();
  const path = join(dir, name);
  writeFileSync(path, privateKeyPem);
  chmodSync(path, mode);
  return { path, pem: privateKeyPem };
}

test("both settings from Fabrica's own environment, with no brain.env at all", () => {
  const dir = home();
  const key = keyFile(dir);

  const credentials = requireAppCredentials({ [APP_ID_VAR]: "Iv1.env", [APP_KEY_VAR]: key.path }, dir);

  assert.equal(credentials.appId, "Iv1.env");
  assert.equal(credentials.keyPath, key.path);
  assert.equal(credentials.privateKeyPem, key.pem);
});

test("both settings from brain.env when the environment has neither", () => {
  const dir = home();
  const key = keyFile(dir);
  brainEnv(dir, `${APP_ID_VAR}=Iv1.file\n${APP_KEY_VAR}=${key.path}\n`);

  const credentials = requireAppCredentials({}, dir);

  assert.equal(credentials.appId, "Iv1.file");
  assert.equal(credentials.keyPath, key.path);
});

test("brain.env accepts an optional leading `export `, so the same file can be sourced by a shell", () => {
  const dir = home();
  const key = keyFile(dir);
  brainEnv(dir, `export ${APP_ID_VAR}=Iv1.exported\nexport ${APP_KEY_VAR}=${key.path}\n`);

  assert.equal(requireAppCredentials({}, dir).appId, "Iv1.exported");
});

test("Fabrica's own environment beats brain.env, the same precedence every other credential has", () => {
  const dir = home();
  const key = keyFile(dir);
  brainEnv(dir, `${APP_ID_VAR}=Iv1.file\n${APP_KEY_VAR}=${key.path}\n`);

  assert.equal(requireAppCredentials({ [APP_ID_VAR]: "Iv1.env" }, dir).appId, "Iv1.env");
});

test("nothing configured: refused, naming both variables and the numbered setup", () => {
  const dir = home();

  assert.throws(
    () => requireAppCredentials({}, dir),
    (err: unknown) =>
      err instanceof GithubAppError &&
      err.code === "app-not-configured" &&
      err.message.includes(APP_ID_VAR) &&
      err.message.includes(APP_KEY_VAR) &&
      // The steps themselves, not a pointer to a document.
      err.message.includes("github.com/settings/apps/new")
  );
});

test("half configured: refused, naming which half is missing", () => {
  const dir = home();
  const key = keyFile(dir);

  assert.throws(
    () => requireAppCredentials({ [APP_ID_VAR]: "Iv1.only" }, dir),
    (err: unknown) =>
      err instanceof GithubAppError && err.code === "app-half-configured" && err.message.includes(APP_KEY_VAR)
  );
  assert.throws(
    () => requireAppCredentials({ [APP_KEY_VAR]: key.path }, dir),
    (err: unknown) =>
      err instanceof GithubAppError && err.code === "app-half-configured" && err.message.includes(APP_ID_VAR)
  );
});

test("a key file that is not there: refused, naming the path it looked at", () => {
  const dir = home();
  const missing = join(dir, "nope.pem");

  assert.throws(
    () => requireAppCredentials({ [APP_ID_VAR]: "Iv1.x", [APP_KEY_VAR]: missing }, dir),
    (err: unknown) => err instanceof GithubAppError && err.code === "app-key-unreadable" && err.message.includes(missing)
  );
});

// Client ruling (issue #187's clarification 4): a path to a mode-600
// .pem, and "any other mode is refused by name". Exactly 600 - this is
// deliberately stricter than brain.env's own check, which refuses only a
// file other users can read. A group-writable private key is as
// replaceable as a readable one.
for (const mode of [0o644, 0o640, 0o604, 0o660, 0o666, 0o400, 0o700, 0o777] as const) {
  test(`a key file at mode ${mode.toString(8)} is refused by name, with chmod 600 as the fix`, () => {
    const dir = home();
    const key = keyFile(dir, `k-${mode.toString(8)}.pem`, mode);

    assert.throws(
      () => requireAppCredentials({ [APP_ID_VAR]: "Iv1.x", [APP_KEY_VAR]: key.path }, dir),
      (err: unknown) =>
        err instanceof GithubAppError &&
        err.code === "app-key-permissions" &&
        err.message.includes(mode.toString(8)) &&
        err.message.includes(`chmod 600 ${key.path}`)
    );
  });
}

test("a file that is not a private key: refused before any task could try to sign with it", () => {
  const dir = home();
  const path = join(dir, "not-a-key.pem");
  writeFileSync(path, "-----BEGIN RSA PRIVATE KEY-----\nnot really\n-----END RSA PRIVATE KEY-----\n");
  chmodSync(path, 0o600);

  assert.throws(
    () => requireAppCredentials({ [APP_ID_VAR]: "Iv1.x", [APP_KEY_VAR]: path }, dir),
    (err: unknown) => err instanceof GithubAppError && err.code === "app-key-invalid"
  );
});

test("no refusal ever carries the key's own bytes", () => {
  const dir = home();
  const key = keyFile(dir, "world.pem", 0o644);

  try {
    requireAppCredentials({ [APP_ID_VAR]: "Iv1.x", [APP_KEY_VAR]: key.path }, dir);
    assert.fail("a world-readable key was accepted");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // One line of a PEM is enough to prove it leaked; the header is
    // shared by every PEM and so is not evidence either way.
    assert.ok(!message.includes(key.pem.split("\n")[1]), "a refusal carried part of the private key");
  }
});

test("a relative key path is resolved against the record home, not the process's working directory", () => {
  const dir = home();
  keyFile(dir, "rel.pem");

  const credentials = requireAppCredentials({ [APP_ID_VAR]: "Iv1.x", [APP_KEY_VAR]: "rel.pem" }, dir);

  assert.equal(credentials.keyPath, join(dir, "rel.pem"));
});

test("a leading ~ in the key path expands to the home directory", () => {
  assert.equal(resolveKeyPath("~/github-app.pem", "/anywhere"), join(process.env.HOME ?? "", "github-app.pem"));
});

test("appSettings reports what is configured without validating any of it", () => {
  const dir = home();
  brainEnv(dir, `${APP_ID_VAR}=Iv1.file\n`);

  assert.deepEqual(appSettings({}, dir), { appId: "Iv1.file", keyPath: undefined });
  assert.deepEqual(appSettings({ [APP_KEY_VAR]: "/x.pem" }, dir), { appId: "Iv1.file", keyPath: "/x.pem" });
});

test("the setup steps name the record home's own paths, so they can be pasted as written", () => {
  const steps = appSetupSteps("/home/someone/.fabrica");

  assert.ok(steps.includes("/home/someone/.fabrica/github-app.pem"));
  assert.ok(steps.includes("/home/someone/.fabrica/brain.env"));
  assert.ok(steps.includes("chmod 600"));
});

test("a leftover personal token is found in the environment and in brain.env, and absence answers null", () => {
  const dir = home();

  assert.equal(leftoverPersonalToken({}, dir), null);
  assert.equal(leftoverPersonalToken({ GITHUB_TOKEN: "ghp_fake" }, dir), "the environment");
  assert.equal(leftoverPersonalToken({ GITHUB_TOKEN: "   " }, dir), null, "an empty value is not a token");

  brainEnv(dir, "GITHUB_TOKEN=ghp_fake\n");
  assert.equal(leftoverPersonalToken({}, dir), join(dir, "brain.env"));
});

test("a brain.env others can read is workerToken's finding to report, not this check's to duplicate", () => {
  const dir = home();
  brainEnv(dir, "GITHUB_TOKEN=ghp_fake\n", 0o644);

  // brainEnvValue throws for a world-readable file; the leftover-token
  // warning swallows that rather than raising a second alarm about one
  // problem `fabrica doctor`'s worker-token line already names.
  assert.equal(leftoverPersonalToken({}, dir), null);
});
