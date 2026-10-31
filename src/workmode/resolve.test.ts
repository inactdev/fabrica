import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/index.ts";
import { projectWorkMode, workModeFor, NO_WORK_MODE } from "./resolve.ts";
import type { FabricaConfig } from "../config/index.ts";

function home(projectsToml: string): string {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-workmode-"));
  writeFileSync(join(recordHome, "projects.toml"), projectsToml);
  return recordHome;
}

function configOf(projectsToml: string): { recordHome: string; config: FabricaConfig } {
  const recordHome = home(projectsToml);
  return { recordHome, config: loadConfig(recordHome) };
}

test("workModeFor: a project's three settings, read off its own entry", () => {
  const { config } = configOf(`
    [projects.dayjob]
    path = "/work/widgets"
    terms = "/fabrica-terms/widgets"
    noStamp = true
    pullRequestTemplate = true
  `);

  assert.deepEqual(workModeFor(config, "/work/widgets"), {
    terms: "/fabrica-terms/widgets",
    noStamp: true,
    pullRequestTemplate: true,
  });
});

test("workModeFor: a registered project that says nothing is work mode off", () => {
  const { config } = configOf(`
    [projects.spending-app]
    path = "/inkling-umbrella/spending-app"
  `);

  assert.deepEqual(workModeFor(config, "/inkling-umbrella/spending-app"), NO_WORK_MODE);
});

test("workModeFor: an unregistered path is work mode off, never a refusal", () => {
  const { config } = configOf(`
    [projects.dayjob]
    path = "/work/widgets"
    terms = "/fabrica-terms/widgets"
  `);

  assert.deepEqual(workModeFor(config, "/somewhere/else"), NO_WORK_MODE);
});

test("workModeFor: one setting on its own leaves the other two off", () => {
  const { config } = configOf(`
    [projects.dayjob]
    path = "/work/widgets"
    noStamp = true
  `);

  assert.deepEqual(workModeFor(config, "/work/widgets"), { noStamp: true, pullRequestTemplate: false });
});

test("workModeFor: matched on the resolved path, so a symlinked registration is still this project", () => {
  // The registry names the project through a symlink - the shape macOS
  // puts in front of tmpdir() with its /var -> /private/var link, and
  // the reason both sides go through realpath here.
  const project = mkdtempSync(join(tmpdir(), "fabrica-workmode-project-"));
  const link = join(mkdtempSync(join(tmpdir(), "fabrica-workmode-link-")), "widgets");
  symlinkSync(project, link, "dir");
  const { config } = configOf(`
    [projects.dayjob]
    path = ${JSON.stringify(link)}
    noStamp = true
  `);

  assert.equal(workModeFor(config, project).noStamp, true);
});

test("projectWorkMode: a record home with no projects.toml is work mode off, not an error", () => {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-workmode-empty-"));
  assert.deepEqual(projectWorkMode(recordHome, "/work/widgets"), NO_WORK_MODE);
});

test("projectWorkMode: reads the same answer as workModeFor from the record home alone", () => {
  const { recordHome } = configOf(`
    [projects.dayjob]
    path = "/work/widgets"
    terms = "/fabrica-terms/widgets"
  `);

  assert.deepEqual(projectWorkMode(recordHome, "/work/widgets"), {
    terms: "/fabrica-terms/widgets",
    noStamp: false,
    pullRequestTemplate: false,
  });
});

test("projectWorkMode: a malformed projects.toml throws rather than reading as work mode off", () => {
  const recordHome = home(`[projects.dayjob]\npath = "/work/widgets"\nterms = 42\n`);
  assert.throws(() => projectWorkMode(recordHome, "/work/widgets"), /terms must be the folder holding/);
});
