// No vendor is named by hand anywhere in this file, deliberately: the
// worker's own vendor is asked of `workerVendor`, the only place
// allowed to know it (CONTRACT rule 8's scan covers these test files
// too), and every other vendor here is a made-up string.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainEnvPath, workerVendor } from "../brain/index.ts";
import { loadConfig } from "../config/index.ts";
import { makeTestHome } from "../config/helpers/test-home.ts";
import { apiKeyVarFor, baseUrlVarFor, resolveReviewer, reviewerFor } from "./resolve.ts";

/** A reviewing vendor that is never the worker's own. */
const OTHER_VENDOR = "second-opinion";
const OTHER_KEY_VAR = apiKeyVarFor(OTHER_VENDOR);
const OTHER_BASE_URL_VAR = baseUrlVarFor(OTHER_VENDOR);

/** A project directory that really exists, so realpath matching in
 * `reviewerFor` has something to resolve on both sides. */
function projectDir(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-reviewer-project-"));
}

function writeBrainEnv(recordHome: string, contents: string): void {
  const path = brainEnvPath(recordHome);
  writeFileSync(path, contents);
  chmodSync(path, 0o600);
}

/** Never the machine's own environment: a real key for some vendor
 * sitting in the tester's shell would make these pass for a reason
 * that has nothing to do with the code under test. */
function resolve(recordHome: string, projectPath: string, declaresTestPaths: boolean, env: NodeJS.ProcessEnv = {}) {
  return resolveReviewer({ recordHome, config: loadConfig(recordHome), projectPath, declaresTestPaths, env });
}

test("apiKeyVarFor/baseUrlVarFor derive the variable names Inspector reads", () => {
  assert.equal(apiKeyVarFor("second-opinion"), "SECOND_OPINION_API_KEY");
  assert.equal(baseUrlVarFor("second-opinion"), "SECOND_OPINION_BASE_URL");
  assert.equal(apiKeyVarFor("  Plain  "), "PLAIN_API_KEY");
});

test("no reviewer configured and no testPaths declared asks for nothing", () => {
  const project = projectDir();
  const recordHome = makeTestHome(`
    [projects.app]
    path = "${project}"
    check = "./check.sh"
  `);

  assert.deepEqual(resolve(recordHome, project, false), { kind: "none" });
});

test("testPaths declared with no reviewer configured refuses, naming the project and the table", () => {
  const project = projectDir();
  const recordHome = makeTestHome(`
    [projects.app]
    path = "${project}"
    check = "./check.sh"
  `);

  const resolution = resolveReviewer({
    recordHome,
    config: loadConfig(recordHome),
    projectPath: project,
    projectLabel: "app",
    declaresTestPaths: true,
    env: {},
  });

  assert.ok(resolution.kind === "refused", `expected a refusal, got ${resolution.kind}`);
  assert.match(resolution.message, /\bapp\b/, "must name the project");
  assert.match(resolution.message, /\[reviewer\]/, "must name the missing table");
  assert.match(resolution.message, /projects\.toml/, "must name the file to add it to");
});

test("a configured reviewer with its key in brain.env resolves to the two flags and the key", () => {
  const project = projectDir();
  const recordHome = makeTestHome(`
    [reviewer]
    vendor = "${OTHER_VENDOR}"
    model = "careful-reader"

    [projects.app]
    path = "${project}"
    check = "./check.sh"
  `);
  writeBrainEnv(recordHome, `${OTHER_KEY_VAR}=secret-review-key\n`);

  const resolution = resolve(recordHome, project, true);

  assert.ok(resolution.kind === "reviewer", `expected a reviewer, got ${resolution.kind}`);
  assert.equal(resolution.reviewer.vendor, OTHER_VENDOR);
  assert.equal(resolution.reviewer.model, "careful-reader");
  assert.equal(resolution.reviewer.apiKeyVar, OTHER_KEY_VAR);
  assert.equal(resolution.reviewer.apiKey, "secret-review-key");
  assert.equal(resolution.reviewer.baseUrl, undefined, "none was set, and none is invented");
});

test("a base url is forwarded when brain.env has one, and never required", () => {
  const project = projectDir();
  const recordHome = makeTestHome(`
    [reviewer]
    vendor = "${OTHER_VENDOR}"
    model = "careful-reader"
  `);
  writeBrainEnv(recordHome, `${OTHER_KEY_VAR}=k\n${OTHER_BASE_URL_VAR}=https://review.test/v1\n`);

  const resolution = resolve(recordHome, project, true);

  assert.ok(resolution.kind === "reviewer", `expected a reviewer, got ${resolution.kind}`);
  assert.equal(resolution.reviewer.baseUrl, "https://review.test/v1");
  assert.equal(resolution.reviewer.baseUrlVar, OTHER_BASE_URL_VAR);
});

test("Fabrica's own environment beats brain.env for the reviewer's key", () => {
  const project = projectDir();
  const recordHome = makeTestHome(`
    [reviewer]
    vendor = "${OTHER_VENDOR}"
    model = "careful-reader"
  `);
  writeBrainEnv(recordHome, `${OTHER_KEY_VAR}=from-file\n`);

  const resolution = resolve(recordHome, project, true, { [OTHER_KEY_VAR]: "from-environment" });

  assert.ok(resolution.kind === "reviewer", `expected a reviewer, got ${resolution.kind}`);
  assert.equal(resolution.reviewer.apiKey, "from-environment");
});

test("a named vendor with no key anywhere refuses, naming the exact variable", () => {
  const project = projectDir();
  const recordHome = makeTestHome(`
    [reviewer]
    vendor = "${OTHER_VENDOR}"
    model = "careful-reader"
  `);

  const resolution = resolve(recordHome, project, true);

  assert.ok(resolution.kind === "refused", `expected a refusal, got ${resolution.kind}`);
  assert.match(resolution.message, new RegExp(OTHER_KEY_VAR));
  assert.match(resolution.message, /brain\.env/);
});

test("a key missing while no testPaths are declared still refuses: a configured reviewer is always passed on", () => {
  const project = projectDir();
  const recordHome = makeTestHome(`
    [reviewer]
    vendor = "${OTHER_VENDOR}"
    model = "careful-reader"
  `);

  assert.equal(resolve(recordHome, project, false).kind, "refused");
});

test("the reviewer must never be the worker's own vendor - refused, naming both", () => {
  const project = projectDir();
  const recordHome = makeTestHome(`
    [projects.app]
    path = "${project}"
    check = "./check.sh"
  `);
  const worker = workerVendor({}, recordHome);
  writeBrainEnv(recordHome, `${apiKeyVarFor(worker)}=a-perfectly-good-key\n`);
  // Written after the home exists, so the vendor can be the one
  // `workerVendor` actually reports rather than a name copied by hand.
  writeFileSync(
    join(recordHome, "projects.toml"),
    `[reviewer]\nvendor = "${worker}"\nmodel = "same-house"\n\n[projects.app]\npath = "${project}"\ncheck = "./check.sh"\n`
  );

  const resolution = resolve(recordHome, project, true);

  assert.ok(resolution.kind === "refused", `expected a refusal, got ${resolution.kind}`);
  assert.match(resolution.message, new RegExp(worker), "must name the vendor that collided");
  assert.match(resolution.message, /worker's vendor/);
  assert.doesNotMatch(resolution.message, /a-perfectly-good-key/, "a refusal never prints a credential");
});

test("the collision is refused however the Client spelled the vendor", () => {
  const project = projectDir();
  const recordHome = makeTestHome("");
  const worker = workerVendor({}, recordHome);
  writeFileSync(
    join(recordHome, "projects.toml"),
    `[reviewer]\nvendor = "  ${worker.toUpperCase()}  "\nmodel = "same-house"\n`
  );

  assert.equal(resolve(recordHome, project, true).kind, "refused");
});

test("a project's own reviewer overrides the global one outright", () => {
  const project = projectDir();
  const other = projectDir();
  const recordHome = makeTestHome(`
    [reviewer]
    vendor = "global-vendor"
    model = "global-model"

    [projects.app]
    path = "${project}"
    check = "./check.sh"

    [projects.app.reviewer]
    vendor = "${OTHER_VENDOR}"
    model = "project-model"
  `);

  const config = loadConfig(recordHome);

  assert.deepEqual(reviewerFor(config, project), { vendor: OTHER_VENDOR, model: "project-model" });
  assert.deepEqual(
    reviewerFor(config, other),
    { vendor: "global-vendor", model: "global-model" },
    "a project with no reviewer of its own falls back to the global table"
  );
});

test("a world-readable brain.env is its own refusal, never read as 'no key configured'", () => {
  const project = projectDir();
  const recordHome = makeTestHome(`
    [reviewer]
    vendor = "${OTHER_VENDOR}"
    model = "careful-reader"
  `);
  const path = brainEnvPath(recordHome);
  writeFileSync(path, `${OTHER_KEY_VAR}=k\n`);
  chmodSync(path, 0o644);

  const resolution = resolve(recordHome, project, true);

  assert.ok(resolution.kind === "refused", `expected a refusal, got ${resolution.kind}`);
  assert.match(resolution.message, /chmod 600/);
});
