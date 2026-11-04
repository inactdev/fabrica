// Which credential a project's image build needs, and whether this
// machine has it (issue #342).
//
// Never the machine's own environment: a `BUNDLE_...` variable in the
// tester's shell would make these pass for a reason that has nothing to
// do with the code under test. Every call below is handed an explicit
// `env`, and `brain.env` is written into a throwaway record home.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainEnvPath } from "../brain/index.ts";
import { loadConfig } from "../config/index.ts";
import { makeTestHome } from "../config/helpers/test-home.ts";
import { INSPECTOR_CONFIG } from "../inspector/index.ts";
import { PAID_SOURCE_VARIABLE } from "../register/helpers/rails-fixture.ts";
import {
  buildSecretsConfigDir,
  describeBuildSecrets,
  resolveBuildSecrets,
  resolveProjectBuildSecrets,
} from "./resolve.ts";

const VALUE = "someone:a-real-looking-password";

function dir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `fabrica-${prefix}-`));
}

/** A folder holding an `.inspector.json` that lists these names. */
function configDir(names: readonly string[] | undefined): string {
  const path = dir("build-secrets-terms");
  writeFileSync(
    join(path, INSPECTOR_CONFIG),
    `${JSON.stringify({ check: "./check.sh", ...(names === undefined ? {} : { buildSecrets: names }) }, null, 2)}\n`
  );
  return path;
}

function writeBrainEnv(recordHome: string, contents: string, mode = 0o600): void {
  const path = brainEnvPath(recordHome);
  writeFileSync(path, contents);
  chmodSync(path, mode);
}

test("a project listing nothing needs nothing, and nothing is read for it", () => {
  const recordHome = dir("home");
  for (const names of [undefined, []]) {
    const resolved = resolveBuildSecrets({ recordHome, configDir: configDir(names), env: {} });
    assert.deepEqual(resolved, { kind: "none" });
    assert.equal(describeBuildSecrets(resolved), "");
  }
});

test("a folder with no .inspector.json in it at all reads as needing nothing", () => {
  const recordHome = dir("home");
  assert.deepEqual(resolveBuildSecrets({ recordHome, configDir: dir("empty"), env: {} }), { kind: "none" });
});

test("a listed name is read from brain.env, and the value never appears in what is printed", () => {
  const recordHome = dir("home");
  // Another line in the same file, to prove only the listed name is
  // read out of it.
  writeBrainEnv(recordHome, `SOMETHING_ELSE_ENTIRELY=unrelated\n${PAID_SOURCE_VARIABLE}=${VALUE}\n`);

  const resolved = resolveBuildSecrets({
    recordHome,
    configDir: configDir([PAID_SOURCE_VARIABLE]),
    env: {},
    projectLabel: "dayjob",
  });
  assert.equal(resolved.kind, "ready");
  assert.deepEqual(resolved.kind === "ready" ? resolved.values : null, { [PAID_SOURCE_VARIABLE]: VALUE });

  // The one line `fabrica doctor` puts on a passing project's own line:
  // the name, and that it is set. Never the value.
  const described = describeBuildSecrets(resolved);
  assert.match(described, new RegExp(PAID_SOURCE_VARIABLE));
  assert.ok(!described.includes(VALUE), `the value must never be printed: ${described}`);
});

test("Fabrica's own environment wins over brain.env, the same precedence every credential has", () => {
  const recordHome = dir("home");
  writeBrainEnv(recordHome, `${PAID_SOURCE_VARIABLE}=from-the-file\n`);

  const resolved = resolveBuildSecrets({
    recordHome,
    configDir: configDir([PAID_SOURCE_VARIABLE]),
    env: { [PAID_SOURCE_VARIABLE]: "from-the-environment" },
  });
  assert.deepEqual(resolved.kind === "ready" ? resolved.values : null, {
    [PAID_SOURCE_VARIABLE]: "from-the-environment",
  });
});

test("a listed name nothing has a value for refuses, naming the variable and the file to put it in", () => {
  const recordHome = dir("home");
  const resolved = resolveBuildSecrets({
    recordHome,
    configDir: configDir([PAID_SOURCE_VARIABLE]),
    env: {},
    projectLabel: "dayjob",
  });
  assert.equal(resolved.kind, "refused");
  if (resolved.kind !== "refused") return;
  assert.deepEqual(resolved.missing, [PAID_SOURCE_VARIABLE]);
  assert.equal(resolved.reason, "missing-build-secret");
  assert.match(resolved.message, new RegExp(PAID_SOURCE_VARIABLE));
  assert.match(resolved.message, /dayjob/);
  assert.match(resolved.message, new RegExp(brainEnvPath(recordHome).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(resolved.fix, new RegExp(`${PAID_SOURCE_VARIABLE}=`));
  // The whole message is what doctor and the build both print, so the
  // refusal reads the same in both places.
  assert.equal(describeBuildSecrets(resolved), resolved.message);
});

test("an empty value is as missing as no line at all", () => {
  const recordHome = dir("home");
  writeBrainEnv(recordHome, `${PAID_SOURCE_VARIABLE}=\n`);
  const resolved = resolveBuildSecrets({
    recordHome,
    configDir: configDir([PAID_SOURCE_VARIABLE]),
    env: { [PAID_SOURCE_VARIABLE]: "   " },
  });
  assert.equal(resolved.kind, "refused");
});

test("one missing name among several is named on its own, and the others are not", () => {
  const recordHome = dir("home");
  writeBrainEnv(recordHome, `BUNDLE_GEMS__A__EXAMPLE__COM=${VALUE}\n`);
  const resolved = resolveBuildSecrets({
    recordHome,
    configDir: configDir(["BUNDLE_GEMS__A__EXAMPLE__COM", "BUNDLE_GEMS__B__EXAMPLE__COM"]),
    env: {},
  });
  assert.equal(resolved.kind, "refused");
  assert.deepEqual(resolved.kind === "refused" ? resolved.missing : null, ["BUNDLE_GEMS__B__EXAMPLE__COM"]);
});

test("a name no environment variable could have refuses as that, not as a missing value", () => {
  const recordHome = dir("home");
  const resolved = resolveBuildSecrets({ recordHome, configDir: configDir(["BUNDLE-GEMS.EXAMPLE"]), env: {} });
  assert.equal(resolved.kind, "refused");
  if (resolved.kind !== "refused") return;
  assert.equal(resolved.reason, "illegal-build-secret-name");
  assert.match(resolved.message, /BUNDLE-GEMS\.EXAMPLE/);
  assert.match(resolved.message, /letters, digits and underscores/);
});

test("a brain.env other users can read stops everything, rather than reading as not set", () => {
  const recordHome = dir("home");
  writeBrainEnv(recordHome, `${PAID_SOURCE_VARIABLE}=${VALUE}\n`, 0o644);
  assert.throws(
    () => resolveBuildSecrets({ recordHome, configDir: configDir([PAID_SOURCE_VARIABLE]), env: {} }),
    /chmod 600/
  );
});

// ------------------------------------- which folder the list is read from

test("a work-mode project's list is read from its terms folder, not its repository", () => {
  const project = dir("project");
  const terms = configDir([PAID_SOURCE_VARIABLE]);
  // A repository that carries its own .inspector.json listing something
  // else entirely: the terms folder is the one Inspector reads, so this
  // one must be ignored.
  writeFileSync(
    join(project, INSPECTOR_CONFIG),
    `${JSON.stringify({ check: "./check.sh", buildSecrets: ["BUNDLE_WRONG__EXAMPLE__COM"] }, null, 2)}\n`
  );
  const recordHome = makeTestHome(`
    [projects.dayjob]
    path  = "${project}"
    check = "./check.sh"
    terms = "${terms}"
  `);
  const config = loadConfig(recordHome);

  assert.equal(buildSecretsConfigDir(config, project), terms);
  const resolved = resolveProjectBuildSecrets({ recordHome, config, projectPath: project, env: {} });
  assert.deepEqual(resolved.kind === "refused" ? resolved.missing : null, [PAID_SOURCE_VARIABLE]);
});

test("an ordinary project's list is read from its repository root", () => {
  const project = dir("project");
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, INSPECTOR_CONFIG),
    `${JSON.stringify({ check: "./check.sh", buildSecrets: [PAID_SOURCE_VARIABLE] }, null, 2)}\n`
  );
  const recordHome = makeTestHome(`
    [projects.app]
    path  = "${project}"
    check = "./check.sh"
  `);
  const config = loadConfig(recordHome);

  assert.equal(buildSecretsConfigDir(config, project), project);
  writeBrainEnv(recordHome, `${PAID_SOURCE_VARIABLE}=${VALUE}\n`);
  const resolved = resolveProjectBuildSecrets({ recordHome, config, projectPath: project, env: {} });
  assert.equal(resolved.kind, "ready");
});
