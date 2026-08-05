// Acceptance criteria for issue #2: a task for an unregistered project, or
// one whose check command is missing, is refused with the exact reason.

import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./load.ts";
import { requireProject } from "./registry.ts";
import { ConfigError } from "./errors.ts";
import { makeTestHome } from "./helpers/test-home.ts";

test("requireProject: a registered project with a check command resolves", () => {
  const recordHome = makeTestHome(`
    [projects.spending-app]
    path = "~/inkling-umbrella/spending-app"
    check = "bin/ci"
  `);
  const config = loadConfig(recordHome);

  const project = requireProject(config, "spending-app");
  assert.deepEqual(project, {
    path: join(homedir(), "inkling-umbrella/spending-app"),
    check: "bin/ci",
  });
});

test("requireProject: an unregistered project is refused, naming it and what to add", () => {
  const recordHome = makeTestHome(`
    [projects.spending-app]
    path = "~/inkling-umbrella/spending-app"
    check = "bin/ci"
  `);
  const config = loadConfig(recordHome);

  assert.throws(
    () => requireProject(config, "ghost-app"),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, "unregistered-project");
      assert.match(err.message, /"ghost-app"/, "must name the project");
      assert.match(err.message, /\[projects\.ghost-app\]/, "must show the table to add");
      assert.match(err.message, /path\s*=/, "must show the path field to add");
      assert.match(err.message, /check\s*=/, "must show the check field to add");
      return true;
    }
  );
});

test("requireProject: a project whose check command is missing is refused", () => {
  const recordHome = makeTestHome(`
    [projects.spending-app]
    path = "~/inkling-umbrella/spending-app"
  `);
  const config = loadConfig(recordHome);

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
      assert.match(err.message, /\[projects\.spending-app\]/, "must show the table to add to");
      assert.match(err.message, /check\s*=/, "must show the check field to add");
      return true;
    }
  );
});

test("requireProject: a name that collides with Object.prototype is unregistered", () => {
  const recordHome = makeTestHome(`
    [projects.spending-app]
    path = "~/inkling-umbrella/spending-app"
    check = "bin/ci"
  `);
  const config = loadConfig(recordHome);

  for (const name of ["toString", "constructor", "valueOf", "__proto__"]) {
    assert.throws(
      () => requireProject(config, name),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError);
        assert.equal(err.code, "unregistered-project", `${name} must read as unregistered`);
        return true;
      }
    );
  }
});

test("requireProject: a project literally named __proto__ still resolves", () => {
  const recordHome = makeTestHome(`
    [projects.__proto__]
    path = "~/inkling-umbrella/proto-app"
    check = "bin/ci"
  `);
  const config = loadConfig(recordHome);

  const project = requireProject(config, "__proto__");
  assert.deepEqual(project, {
    path: join(homedir(), "inkling-umbrella/proto-app"),
    check: "bin/ci",
  });
});

test("requireProject: a project literally named caps resolves, distinct from the [caps] table", () => {
  const recordHome = makeTestHome(`
    [caps]
    perTaskUsd = 5

    [projects.caps]
    path = "~/inkling-umbrella/caps"
    check = "bin/ci"
  `);
  const config = loadConfig(recordHome);

  const project = requireProject(config, "caps");
  assert.deepEqual(project, {
    path: join(homedir(), "inkling-umbrella/caps"),
    check: "bin/ci",
  });
});

test("requireProject: a blank check command counts as missing", () => {
  const recordHome = makeTestHome(`
    [projects.spending-app]
    path = "~/inkling-umbrella/spending-app"
    check = "   "
  `);
  const config = loadConfig(recordHome);

  assert.throws(
    () => requireProject(config, "spending-app"),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, "missing-check");
      return true;
    }
  );
});
