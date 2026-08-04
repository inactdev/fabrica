import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./load.ts";
import { ConfigError } from "./errors.ts";
import { makeTestHome } from "./helpers/test-home.ts";

test("loadConfig: a valid config loads projects and caps", () => {
  const home = makeTestHome(`
    [caps]
    perTaskUsd = 2.5
    perDayUsd = 20

    [projects.spending-app]
    path = "~/inkling-umbrella/spending-app"
    check = "bin/ci"

    [projects.other-app]
    path = "~/inkling-umbrella/other-app"
    check = "npm test"
  `);

  const config = loadConfig(home);

  assert.deepEqual(config.caps, { perTaskUsd: 2.5, perDayUsd: 20 });
  assert.deepEqual(config.projects["spending-app"], {
    path: join(homedir(), "inkling-umbrella/spending-app"),
    check: "bin/ci",
  });
  assert.deepEqual(config.projects["other-app"], {
    path: join(homedir(), "inkling-umbrella/other-app"),
    check: "npm test",
  });
});

test("loadConfig: caps are optional", () => {
  const home = makeTestHome(`
    [projects.spending-app]
    path = "~/inkling-umbrella/spending-app"
    check = "bin/ci"
  `);

  const config = loadConfig(home);
  assert.deepEqual(config.caps, {});
});

test("loadConfig: a project may be registered without a check yet", () => {
  const home = makeTestHome(`
    [projects.spending-app]
    path = "~/inkling-umbrella/spending-app"
  `);

  const config = loadConfig(home);
  assert.deepEqual(config.projects["spending-app"], {
    path: join(homedir(), "inkling-umbrella/spending-app"),
  });
});

test("loadConfig: a project named caps loads correctly, distinct from the [caps] table", () => {
  const home = makeTestHome(`
    [caps]
    perTaskUsd = 5

    [projects.caps]
    path = "~/inkling-umbrella/caps"
    check = "bin/ci"
  `);

  const config = loadConfig(home);
  assert.deepEqual(config.caps, { perTaskUsd: 5 });
  assert.deepEqual(config.projects["caps"], {
    path: join(homedir(), "inkling-umbrella/caps"),
    check: "bin/ci",
  });
});

test("loadConfig: an unknown top-level table is refused with conversion instructions", () => {
  const home = makeTestHome(`
    [spending-app]
    path = "~/inkling-umbrella/spending-app"
    check = "bin/ci"
  `);

  assert.throws(
    () => loadConfig(home),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, "malformed");
      assert.match(err.message, /\[spending-app\]/, "must name the stale table");
      assert.match(err.message, /\[projects\.spending-app\]/, "must show where it belongs now");
      return true;
    }
  );
});

test("loadConfig: an unknown top-level key that is not a table is not called a table", () => {
  const home = makeTestHome(`
    home = "/srv/x"
    stamped = 2024-01-01T00:00:00Z

    [projects.spending-app]
    path = "~/inkling-umbrella/spending-app"
    check = "bin/ci"
  `);

  assert.throws(
    () => loadConfig(home),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, "malformed");
      assert.match(err.message, /unknown top-level key\(s\): home, stamped/);
      assert.doesNotMatch(err.message, /\[home\]/, "a string value is not a table");
      assert.doesNotMatch(
        err.message,
        /\[projects\.home\]/,
        "must not advise a rename that parseProject would then reject"
      );
      return true;
    }
  );
});

test("loadConfig: a leading ~/ in a project path expands to the home directory", () => {
  const home = makeTestHome(`
    [projects.spending-app]
    path = "~/inkling-umbrella/spending-app"
    check = "bin/ci"
  `);

  const config = loadConfig(home);
  assert.equal(
    config.projects["spending-app"].path,
    join(homedir(), "inkling-umbrella/spending-app")
  );
});

test("loadConfig: a bare ~ project path is the home directory itself", () => {
  const home = makeTestHome(`
    [projects.home-app]
    path = "~"
    check = "bin/ci"
  `);

  const config = loadConfig(home);
  assert.equal(config.projects["home-app"].path, homedir());
});

test("loadConfig: a ~ anywhere but the start is left verbatim", () => {
  const home = makeTestHome(`
    [projects.tilde-app]
    path = "/srv/back~ups/tilde-app"
    check = "bin/ci"

    [projects.nested-app]
    path = "/srv/~/nested-app"
    check = "bin/ci"
  `);

  const config = loadConfig(home);
  assert.equal(config.projects["tilde-app"].path, "/srv/back~ups/tilde-app");
  assert.equal(config.projects["nested-app"].path, "/srv/~/nested-app");
});

test("loadConfig: no projects.toml at the given home fails with the exact path", () => {
  const home = mkdtempSync(join(tmpdir(), "fabrica-config-test-empty-"));

  assert.throws(
    () => loadConfig(home),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, "not-found");
      assert.match(err.message, new RegExp(join(home, "projects.toml").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(
        err.message,
        /\[projects\.<name>\]/,
        "must instruct the nested format, not the old flat one"
      );
      return true;
    }
  );
});

test("loadConfig: invalid TOML syntax is refused as malformed", () => {
  const home = makeTestHome(`this is not [valid toml`);

  assert.throws(
    () => loadConfig(home),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, "malformed");
      return true;
    }
  );
});

test("loadConfig: a project table missing path is refused as malformed", () => {
  const home = makeTestHome(`
    [projects.spending-app]
    check = "bin/ci"
  `);

  assert.throws(
    () => loadConfig(home),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, "malformed");
      assert.match(err.message, /spending-app/);
      assert.match(err.message, /path/);
      return true;
    }
  );
});

test("loadConfig: a zero cap is a legal cap, not an absent one", () => {
  const home = makeTestHome(`
    [caps]
    perTaskUsd = 0
    perDayUsd = 0
  `);

  const config = loadConfig(home);
  assert.deepEqual(config.caps, { perTaskUsd: 0, perDayUsd: 0 });
});

test("loadConfig: a negative cap is refused as malformed", () => {
  const home = makeTestHome(`
    [caps]
    perTaskUsd = -5
  `);

  assert.throws(
    () => loadConfig(home),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, "malformed");
      assert.match(err.message, /perTaskUsd/);
      return true;
    }
  );
});

test("loadConfig: a non-finite cap is refused as malformed", () => {
  const home = makeTestHome(`
    [caps]
    perDayUsd = inf
  `);

  assert.throws(
    () => loadConfig(home),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, "malformed");
      assert.match(err.message, /perDayUsd/);
      return true;
    }
  );
});

test("loadConfig: a non-numeric cap is refused as malformed", () => {
  const home = makeTestHome(`
    [caps]
    perDayUsd = "twenty"
  `);

  assert.throws(
    () => loadConfig(home),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, "malformed");
      assert.match(err.message, /perDayUsd/);
      return true;
    }
  );
});
