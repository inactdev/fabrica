// Issue #331: reading a GitHub token from the GitHub CLI's own login.
//
// Every test here spawns a real stand-in `gh` on a PATH of its own (see
// helpers/fake-gh.ts) - never the machine's own, where the tester's
// login would decide whether a test passes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GH_LOGIN_COMMAND, ghAuthToken, ghLoginRefusal } from "./gh.ts";
import { fakeGh, noGh } from "./helpers/fake-gh.ts";

test("ghAuthToken: asks gh for the github.com token and answers with it", () => {
  const gh = fakeGh("printf 'gho_abcdef\\n'");

  const read = ghAuthToken({ env: gh.env });

  assert.deepEqual(read, { kind: "token", token: "gho_abcdef" });
  // The hostname is named explicitly: gh's own default host can be moved
  // by a GH_HOST in the environment or an enterprise login, and this
  // token is about to be used against api.github.com.
  assert.deepEqual(gh.calls(), ["auth token --hostname github.com"]);
});

test("ghAuthToken: no gh on this machine is its own finding, with its own fix", () => {
  const read = ghAuthToken({ env: noGh() });

  assert.equal(read.kind, "problem");
  assert.match(read.kind === "problem" ? read.detail : "", /not installed/);
  // "Install it" and "log in" are different fixes, so they are different
  // findings - a machine with no gh is not told to run `gh auth login`
  // alone.
  assert.match(read.kind === "problem" ? read.fix : "", /install the GitHub CLI/);
  assert.match(read.kind === "problem" ? read.fix : "", /gh auth login/);
});

test("ghAuthToken: gh's own exit code 4 is read as logged out", () => {
  // gh help exit-codes: 4 means authentication is required.
  const gh = fakeGh("echo 'not logged in' >&2\nexit 4");

  const read = ghAuthToken({ env: gh.env });

  assert.equal(read.kind, "problem");
  assert.match(read.kind === "problem" ? read.detail : "", /installed but not logged in to github\.com/);
  assert.equal(read.kind === "problem" ? read.fix : "", GH_LOGIN_COMMAND);
});

test("ghAuthToken: any other failure is reported in gh's own words", () => {
  const gh = fakeGh("echo 'the keychain is locked' >&2\nexit 1");

  const read = ghAuthToken({ env: gh.env });

  assert.equal(read.kind, "problem");
  assert.match(read.kind === "problem" ? read.detail : "", /the keychain is locked/);
});

test("ghAuthToken: a failed run's own stdout never reaches the finding", () => {
  // The sharp edge this module exists to hold in one place: `gh auth
  // token` prints the credential on stdout, so a diagnostic built from
  // the whole output would print the Client's GitHub token into his
  // terminal and into `fabrica log` from then on.
  const gh = fakeGh("printf 'gho_leaked_secret\\n'\necho 'refreshing failed' >&2\nexit 1");

  const read = ghAuthToken({ env: gh.env });

  assert.equal(read.kind, "problem");
  const said = read.kind === "problem" ? `${read.detail} ${read.fix}` : "";
  assert.doesNotMatch(said, /gho_leaked_secret/);
  assert.match(said, /refreshing failed/);
});

test("ghAuthToken: a run that succeeds and prints nothing is no login, not an empty token", () => {
  const gh = fakeGh("exit 0");

  const read = ghAuthToken({ env: gh.env });

  assert.equal(read.kind, "problem");
  assert.match(read.kind === "problem" ? read.detail : "", /printed no token/);
  assert.equal(read.kind === "problem" ? read.fix : "", GH_LOGIN_COMMAND);
});

test("ghLoginRefusal: names the setting, the fix, and why nothing else is tried instead", () => {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-gh-refusal-"));

  const message = ghLoginRefusal(recordHome, "dayjob", { detail: "it is not logged in", fix: GH_LOGIN_COMMAND });

  assert.match(message, /dayjob/);
  assert.match(message, /githubToken = "gh"/);
  assert.match(message, new RegExp(join(recordHome, "projects.toml").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(message, /it is not logged in/);
  assert.match(message, /gh auth login --hostname github\.com/);
  // Issue #314's rule, repeated for this credential: never a fallback,
  // in either direction.
  assert.match(message, /does not fall back/);
});
