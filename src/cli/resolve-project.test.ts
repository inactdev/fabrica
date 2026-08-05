import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../index.ts";
import type { FabricaConfig } from "../index.ts";
import { CliError } from "./errors.ts";
import { resolveProjectPath } from "./resolve-project.ts";

test("resolveProjectPath: a registered name resolves to its configured path", () => {
  const config: FabricaConfig = {
    caps: {},
    projects: { spending: { path: "/repos/spending-app", check: "npm test" } },
  };
  assert.equal(resolveProjectPath(config, "spending"), "/repos/spending-app");
});

test("resolveProjectPath: a registered name with no check refuses with exact instructions", () => {
  const config: FabricaConfig = { caps: {}, projects: { spending: { path: "/repos/spending-app" } } };
  assert.throws(
    () => resolveProjectPath(config, "spending"),
    (err: unknown) => err instanceof ConfigError && err.code === "missing-check"
  );
});

test("resolveProjectPath: an existing directory not registered by name is used as a literal path", () => {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-cli-resolve-project-"));
  const config: FabricaConfig = { caps: {}, projects: {} };
  assert.equal(resolveProjectPath(config, dir), dir);
});

test("resolveProjectPath: a relative path resolves against the given cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-cli-resolve-project-"));
  const config: FabricaConfig = { caps: {}, projects: {} };
  assert.equal(resolveProjectPath(config, ".", dir), dir);
});

test("resolveProjectPath: neither a registered name nor an existing directory refuses with exact instructions", () => {
  const config: FabricaConfig = { caps: {}, projects: {} };
  assert.throws(
    () => resolveProjectPath(config, "/definitely/not/a/real/path/anywhere"),
    (err: unknown) =>
      err instanceof CliError &&
      err.code === "project-not-found" &&
      err.message.includes("/definitely/not/a/real/path/anywhere") &&
      err.message.includes("[projects.<name>]")
  );
});
