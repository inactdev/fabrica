// No vendor is named by hand anywhere in this file - every vendor here
// is a made-up string (CONTRACT rule 8's scan covers test files too).

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainEnvPath } from "../brain/index.ts";
import { loadConfig } from "../config/index.ts";
import { makeTestHome } from "../config/helpers/test-home.ts";
import { apiKeyVarFor, baseUrlVarFor } from "../reviewer/index.ts";
import { missingReaderMessage, readerFor, resolveReader } from "./resolve.ts";

const VENDOR = "close-reader";
const KEY_VAR = apiKeyVarFor(VENDOR);
const BASE_URL_VAR = baseUrlVarFor(VENDOR);
const ENDPOINT = "https://example.invalid/v1";

/** A project directory that really exists, so the realpath matching in
 * `readerFor` has something to resolve on both sides. */
function projectDir(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-reader-project-"));
}

function writeBrainEnv(recordHome: string, contents: string): void {
  const path = brainEnvPath(recordHome);
  writeFileSync(path, contents);
  chmodSync(path, 0o600);
}

/** Never the machine's own environment: a real key for some vendor
 * sitting in the tester's shell would make these pass for a reason
 * that has nothing to do with the code under test. */
function resolve(recordHome: string, projectPath: string, env: NodeJS.ProcessEnv = {}) {
  return resolveReader({ recordHome, config: loadConfig(recordHome), projectPath, env });
}

const WORKING_ENV = { [KEY_VAR]: "k", [BASE_URL_VAR]: ENDPOINT };

test("a project with no reader configured is refused, with the lines to add", () => {
  const project = projectDir();
  const recordHome = makeTestHome(`
    [projects.app]
    path = "${project}"
    check = "./check.sh"
  `);

  const resolution = resolve(recordHome, project);
  assert.equal(resolution.kind, "refused");
  const message = resolution.kind === "refused" ? resolution.message : "";
  assert.match(message, /\[reader\]/);
  assert.match(message, /vendor = /);
  assert.match(message, /model {2}= /);
  assert.match(message, /projects\.toml/);
});

test("a missing reader never falls back to the configured reviewer", () => {
  const project = projectDir();
  const recordHome = makeTestHome(`
    [reviewer]
    vendor = "some-reviewer"
    model = "some-reviewer-model"

    [projects.app]
    path = "${project}"
  `);

  const resolution = resolve(recordHome, project, { SOME_REVIEWER_API_KEY: "k", SOME_REVIEWER_BASE_URL: ENDPOINT });
  assert.equal(resolution.kind, "refused", "the reviewer was borrowed for the reader");
  const message = resolution.kind === "refused" ? resolution.message : "";
  assert.ok(!message.includes("some-reviewer"), "the refusal pointed at the reviewer's own vendor");
});

test("the global [reader] settles, with both credentials", () => {
  const project = projectDir();
  const recordHome = makeTestHome(`
    [reader]
    vendor = "${VENDOR}"
    model = "reader-1"

    [projects.app]
    path = "${project}"
  `);

  const resolution = resolve(recordHome, project, WORKING_ENV);
  assert.equal(resolution.kind, "reader");
  assert.deepEqual(resolution.kind === "reader" ? resolution.reader : undefined, {
    vendor: VENDOR,
    model: "reader-1",
    apiKeyVar: KEY_VAR,
    apiKey: "k",
    baseUrlVar: BASE_URL_VAR,
    baseUrl: ENDPOINT,
  });
});

test("a project's own [reader] wins outright over the global one", () => {
  const project = projectDir();
  const other = projectDir();
  const recordHome = makeTestHome(`
    [reader]
    vendor = "${VENDOR}"
    model = "global-1"

    [projects.app]
    path = "${project}"
    [projects.app.reader]
    vendor = "${VENDOR}"
    model = "project-1"

    [projects.other]
    path = "${other}"
  `);

  const config = loadConfig(recordHome);
  assert.equal(readerFor(config, project)?.model, "project-1");
  assert.equal(readerFor(config, other)?.model, "global-1");
});

test("a reader with no API key is refused, naming the variable and brain.env", () => {
  const project = projectDir();
  const recordHome = makeTestHome(`
    [reader]
    vendor = "${VENDOR}"
    model = "reader-1"

    [projects.app]
    path = "${project}"
  `);

  const resolution = resolve(recordHome, project, { [BASE_URL_VAR]: ENDPOINT });
  assert.equal(resolution.kind, "refused");
  const message = resolution.kind === "refused" ? resolution.message : "";
  assert.match(message, new RegExp(KEY_VAR));
  assert.match(message, /brain\.env/);
});

test("a reader with no base URL is refused: Fabrica dials this call itself", () => {
  const project = projectDir();
  const recordHome = makeTestHome(`
    [reader]
    vendor = "${VENDOR}"
    model = "reader-1"

    [projects.app]
    path = "${project}"
  `);

  const resolution = resolve(recordHome, project, { [KEY_VAR]: "k" });
  assert.equal(resolution.kind, "refused");
  const message = resolution.kind === "refused" ? resolution.message : "";
  assert.match(message, new RegExp(BASE_URL_VAR));
  assert.match(message, /chat-completions/);
});

test("both credentials are read from brain.env when the environment has neither", () => {
  const project = projectDir();
  const recordHome = makeTestHome(`
    [reader]
    vendor = "${VENDOR}"
    model = "reader-1"

    [projects.app]
    path = "${project}"
  `);
  writeBrainEnv(recordHome, `${KEY_VAR}=from-file\n${BASE_URL_VAR}=${ENDPOINT}\n`);

  const resolution = resolve(recordHome, project);
  assert.equal(resolution.kind, "reader");
  assert.equal(resolution.kind === "reader" ? resolution.reader.apiKey : "", "from-file");
  assert.equal(resolution.kind === "reader" ? resolution.reader.baseUrl : "", ENDPOINT);
});

test("a brain.env other users can read is its own refusal, not 'no key'", () => {
  const project = projectDir();
  const recordHome = makeTestHome(`
    [reader]
    vendor = "${VENDOR}"
    model = "reader-1"

    [projects.app]
    path = "${project}"
  `);
  const path = brainEnvPath(recordHome);
  writeFileSync(path, `${KEY_VAR}=k\n`);
  chmodSync(path, 0o644);

  const resolution = resolve(recordHome, project);
  assert.equal(resolution.kind, "refused");
  const message = resolution.kind === "refused" ? resolution.message : "";
  assert.ok(!message.includes("is not set"), `read as a missing key instead of a permissions refusal: ${message}`);
});

test("a record home with no projects.toml still refuses, with the same lines", () => {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-reader-home-"));
  const project = projectDir();

  const resolution = resolveReader({
    recordHome,
    config: { caps: {}, pause: { sevenDayRefusePercent: 70, sevenDayStopPercent: 90, fiveHourRefusePercent: 90 }, projects: {} },
    projectPath: project,
    env: {},
  });
  assert.equal(resolution.kind, "refused");
  assert.equal(resolution.kind === "refused" ? resolution.message : "", missingReaderMessage(recordHome, project));
});
