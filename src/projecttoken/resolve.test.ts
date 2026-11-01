// Which credential a project reaches GitHub with (issue #314).
//
// Never the machine's own environment: a token sitting in the tester's
// shell would make these pass for a reason that has nothing to do with
// the code under test, and `brain.env` is where the real thing lives
// anyway.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainEnvPath } from "../brain/index.ts";
import { loadConfig } from "../config/index.ts";
import { makeTestHome } from "../config/helpers/test-home.ts";
import {
  describeProjectCredential,
  projectTokenVarFor,
  projectUsesGhLogin,
  resolveProjectToken,
} from "./resolve.ts";

const VAR = "DAYJOB_GITHUB_TOKEN";

/** A project directory that really exists, so the realpath matching in
 * `projectTokenVarFor` has something to resolve on both sides. */
function projectDir(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-project-token-"));
}

function writeBrainEnv(recordHome: string, contents: string, mode = 0o600): void {
  const path = brainEnvPath(recordHome);
  writeFileSync(path, contents);
  chmodSync(path, mode);
}

function resolve(recordHome: string, projectPath: string, env: NodeJS.ProcessEnv = {}) {
  return resolveProjectToken({ recordHome, config: loadConfig(recordHome), projectPath, env });
}

function homeFor(project: string, entry = ""): string {
  return makeTestHome(`
    [projects.app]
    path = "${project}"
    check = "./check.sh"
    ${entry}
  `);
}

test("a project that names no token uses the GitHub App - every project today", () => {
  const project = projectDir();
  const recordHome = homeFor(project);

  assert.equal(projectTokenVarFor(loadConfig(recordHome), project), undefined);
  assert.deepEqual(resolve(recordHome, project), { kind: "app" });
});

test("a project nobody registered uses the App too, rather than refusing", () => {
  const recordHome = homeFor(projectDir());

  assert.deepEqual(resolve(recordHome, projectDir()), { kind: "app" });
});

test("a named variable is read from brain.env, exactly like every other credential", () => {
  const project = projectDir();
  const recordHome = homeFor(project, `githubTokenVar = "${VAR}"`);
  writeBrainEnv(recordHome, `${VAR}=github_pat_fake\n`);

  const resolution = resolve(recordHome, project);
  assert.deepEqual(resolution, { kind: "token", token: { variable: VAR, token: "github_pat_fake" } });
});

test("Fabrica's own environment wins over brain.env, the precedence every credential has", () => {
  const project = projectDir();
  const recordHome = homeFor(project, `githubTokenVar = "${VAR}"`);
  writeBrainEnv(recordHome, `${VAR}=from-the-file\n`);

  const resolution = resolve(recordHome, project, { [VAR]: "from-the-environment" });
  assert.equal(resolution.kind === "token" && resolution.token.token, "from-the-environment");
});

test("a named variable set nowhere is refused, naming the line to add and never falling back to the App", () => {
  const project = projectDir();
  const recordHome = homeFor(project, `githubTokenVar = "${VAR}"`);
  writeBrainEnv(recordHome, "SOMETHING_ELSE=x\n");

  const resolution = resolve(recordHome, project);
  assert.equal(resolution.kind, "refused");
  if (resolution.kind !== "refused") return;
  assert.equal(resolution.variable, VAR);
  assert.match(resolution.message, new RegExp(`${VAR} is not set`));
  assert.match(resolution.message, /does not fall back to the GitHub App/);
  assert.match(resolution.fix, new RegExp(`${VAR}=<the token>`));
  assert.match(resolution.fix, /brain\.env/);
});

test("a brain.env other users can read is refused in its own words, not read as 'no token'", () => {
  const project = projectDir();
  const recordHome = homeFor(project, `githubTokenVar = "${VAR}"`);
  writeBrainEnv(recordHome, `${VAR}=github_pat_fake\n`, 0o644);

  const resolution = resolve(recordHome, project);
  assert.equal(resolution.kind, "refused");
  if (resolution.kind !== "refused") return;
  assert.match(resolution.message, /can be read by other users/);
  assert.match(resolution.fix, /chmod 600/);
});

test("no refusal and no report ever carries the token itself - only the variable's name", () => {
  const project = projectDir();
  const recordHome = homeFor(project, `githubTokenVar = "${VAR}"`);
  writeBrainEnv(recordHome, `${VAR}=github_pat_fake\n`);

  const described = describeProjectCredential(resolve(recordHome, project));
  assert.match(described, new RegExp(VAR));
  assert.doesNotMatch(described, /github_pat_fake/);
});

test("describeProjectCredential says which path a project uses, for doctor's own line", () => {
  assert.match(describeProjectCredential({ kind: "app" }), /GitHub App/);
  assert.match(
    describeProjectCredential({ kind: "token", token: { variable: VAR, token: "x" } }),
    new RegExp(`its own token \\(${VAR}\\)`)
  );
  assert.match(describeProjectCredential({ kind: "gh" }), /the gh login/);
});

// Issue #331: the second form of the same setting. This module answers
// *which* credential and never touches one, so a gh project resolves
// without `gh` being installed, logged in, or consulted at all - what
// that login can do is ./gh.ts's and ./gh-push.ts's question.

test('githubToken = "gh" resolves to the gh login, and carries no credential with it', () => {
  const project = projectDir();
  const recordHome = homeFor(project, 'githubToken = "gh"');

  assert.equal(projectUsesGhLogin(loadConfig(recordHome), project), true);
  assert.deepEqual(resolve(recordHome, project), { kind: "gh" });
  // Nothing of brain.env is involved either: a gh project is not asked
  // for a variable it does not name.
  assert.equal(projectTokenVarFor(loadConfig(recordHome), project), undefined);
});

test("a gh project resolves the same with a brain.env nobody can read - it reads none of it", () => {
  const project = projectDir();
  const recordHome = homeFor(project, 'githubToken = "gh"');
  writeBrainEnv(recordHome, `${VAR}=github_pat_fake\n`, 0o644);

  assert.deepEqual(resolve(recordHome, project), { kind: "gh" });
});

test("projectUsesGhLogin is false for a project that names a token, and for an unregistered one", () => {
  const project = projectDir();
  const recordHome = homeFor(project, `githubTokenVar = "${VAR}"`);

  assert.equal(projectUsesGhLogin(loadConfig(recordHome), project), false);
  assert.equal(projectUsesGhLogin(loadConfig(recordHome), projectDir()), false);
});
