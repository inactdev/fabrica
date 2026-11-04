import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSPECTOR_CONFIG } from "../inspector/index.ts";
import { declaredBuildSecrets } from "./declared.ts";

function folderWith(config: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-declared-secrets-"));
  writeFileSync(join(dir, INSPECTOR_CONFIG), config);
  return dir;
}

test("the names .inspector.json lists, in order, with blanks and duplicates dropped", () => {
  const dir = folderWith(
    JSON.stringify({
      check: "./check.sh",
      buildSecrets: ["BUNDLE_B__EXAMPLE__COM", " BUNDLE_A__EXAMPLE__COM ", "", "BUNDLE_B__EXAMPLE__COM", 7, null],
    })
  );
  assert.deepEqual(declaredBuildSecrets(dir), ["BUNDLE_B__EXAMPLE__COM", "BUNDLE_A__EXAMPLE__COM"]);
});

test("a config with no buildSecrets key, no config at all, or an unparseable one, lists nothing", () => {
  assert.deepEqual(declaredBuildSecrets(folderWith(JSON.stringify({ check: "./check.sh" }))), []);
  assert.deepEqual(declaredBuildSecrets(mkdtempSync(join(tmpdir(), "fabrica-no-config-"))), []);
  // An unparseable .inspector.json is Inspector's own refusal to make,
  // and src/inspector/config-check.ts already names it on every round -
  // claiming "no build secrets" here is the honest answer, not a
  // finding of this reader's.
  assert.deepEqual(declaredBuildSecrets(folderWith("{ not json")), []);
  assert.deepEqual(declaredBuildSecrets(folderWith(`["an array"]`)), []);
  assert.deepEqual(declaredBuildSecrets(folderWith(JSON.stringify({ buildSecrets: "A_NAME" }))), []);
});

test("a name an environment variable could not have is still returned, for the resolver to refuse by name", () => {
  // Read what the file says; judge it in one place (resolve.ts). A
  // reader that silently dropped it would turn a config the Client has
  // to fix into a project that quietly needs no credential.
  const dir = folderWith(JSON.stringify({ check: "./check.sh", buildSecrets: ["BUNDLE-A.EXAMPLE"] }));
  assert.deepEqual(declaredBuildSecrets(dir), ["BUNDLE-A.EXAMPLE"]);
});

// The in-repository case's one load-bearing detail: the list says which
// of brain.env's variables are handed to an image build, so it has to be
// the list the Client committed - not the copy in a worktree a Worker
// has been writing in.
test("a revision reads the list the commit carries, never the one in the working tree", () => {
  const dir = folderWith(JSON.stringify({ check: "./check.sh", buildSecrets: ["BUNDLE_COMMITTED__EXAMPLE__COM"] }));
  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  };
  git(["init", "-q"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "the config the Client committed"]);

  // What a Worker could do in its own worktree: name a different
  // variable - any variable brain.env happens to hold.
  writeFileSync(
    join(dir, INSPECTOR_CONFIG),
    JSON.stringify({ check: "./check.sh", buildSecrets: ["BUNDLE_SOMETHING__ELSE__EXAMPLE__COM"] })
  );

  assert.deepEqual(declaredBuildSecrets(dir, "HEAD"), ["BUNDLE_COMMITTED__EXAMPLE__COM"]);
  assert.deepEqual(
    declaredBuildSecrets(dir),
    ["BUNDLE_SOMETHING__ELSE__EXAMPLE__COM"],
    "and the unpinned read really does see the other one, so the test above is not passing by accident"
  );
});

test("a revision with no config in it, or no git at all, lists nothing rather than throwing", () => {
  const dir = folderWith(JSON.stringify({ check: "./check.sh", buildSecrets: ["BUNDLE_A__EXAMPLE__COM"] }));
  assert.deepEqual(declaredBuildSecrets(dir, "HEAD"), []);
});
