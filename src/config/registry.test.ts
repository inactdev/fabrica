// Acceptance criteria for issue #2: a task for an unregistered project, or
// one whose check command is missing, is refused with the exact reason.

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./load.ts";
import { requireProject } from "./registry.ts";
import { ConfigError } from "./errors.ts";
import { makeTestHome } from "./helpers/test-home.ts";

test("requireProject: a registered project with a check command resolves", () => {
  const home = makeTestHome(`
    [spending-app]
    path = "/code/spending-app"
    check = "bin/ci"
  `);
  const config = loadConfig(home);

  const project = requireProject(config, "spending-app");
  assert.deepEqual(project, { path: "/code/spending-app", check: "bin/ci" });
});

test("requireProject: an unregistered project is refused, naming it and what to add", () => {
  const home = makeTestHome(`
    [spending-app]
    path = "/code/spending-app"
    check = "bin/ci"
  `);
  const config = loadConfig(home);

  assert.throws(
    () => requireProject(config, "ghost-app"),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, "unregistered-project");
      assert.match(err.message, /"ghost-app"/, "must name the project");
      assert.match(err.message, /\[ghost-app\]/, "must show the table to add");
      assert.match(err.message, /path\s*=/, "must show the path field to add");
      assert.match(err.message, /check\s*=/, "must show the check field to add");
      return true;
    }
  );
});

test("requireProject: a project whose check command is missing is refused", () => {
  const home = makeTestHome(`
    [spending-app]
    path = "/code/spending-app"
  `);
  const config = loadConfig(home);

  assert.throws(
    () => requireProject(config, "spending-app"),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, "missing-check");
      assert.match(err.message, /"spending-app"/, "must name the project");
      assert.match(
        err.message,
        /No check command, no verified work, no exceptions/,
        "must use SPEC's exact wording"
      );
      assert.match(err.message, /\[spending-app\]/, "must show the table to add to");
      assert.match(err.message, /check\s*=/, "must show the check field to add");
      return true;
    }
  );
});

test("requireProject: a blank check command counts as missing", () => {
  const home = makeTestHome(`
    [spending-app]
    path = "/code/spending-app"
    check = "   "
  `);
  const config = loadConfig(home);

  assert.throws(
    () => requireProject(config, "spending-app"),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, "missing-check");
      return true;
    }
  );
});
