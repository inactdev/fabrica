import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PAUSE_RULE, loadConfig, loadConfigOrProblem, projectsTomlPath } from "./load.ts";
import { ConfigError } from "./errors.ts";
import { makeTestHome } from "./helpers/test-home.ts";

test("loadConfig: a valid config loads projects and caps", () => {
  const recordHome = makeTestHome(`
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

  const config = loadConfig(recordHome);

  assert.deepEqual(config.caps, { perTaskUsd: 2.5, perDayUsd: 20 });
  assert.deepEqual(config.projects["spending-app"], {
    path: join(homedir(), "inkling-umbrella/spending-app"),
    check: "bin/ci",
    onlyTouchedTests: true,
  });
  assert.deepEqual(config.projects["other-app"], {
    path: join(homedir(), "inkling-umbrella/other-app"),
    check: "npm test",
    onlyTouchedTests: true,
  });
});

test("loadConfig: caps are optional", () => {
  const recordHome = makeTestHome(`
    [projects.spending-app]
    path = "~/inkling-umbrella/spending-app"
    check = "bin/ci"
  `);

  const config = loadConfig(recordHome);
  assert.deepEqual(config.caps, {});
});

test("loadConfig: a project may be registered without a check yet", () => {
  const recordHome = makeTestHome(`
    [projects.spending-app]
    path = "~/inkling-umbrella/spending-app"
  `);

  const config = loadConfig(recordHome);
  assert.deepEqual(config.projects["spending-app"], {
    path: join(homedir(), "inkling-umbrella/spending-app"),
    onlyTouchedTests: true,
  });
});

test("loadConfig: a project named caps loads correctly, distinct from the [caps] table", () => {
  const recordHome = makeTestHome(`
    [caps]
    perTaskUsd = 5

    [projects.caps]
    path = "~/inkling-umbrella/caps"
    check = "bin/ci"
  `);

  const config = loadConfig(recordHome);
  assert.deepEqual(config.caps, { perTaskUsd: 5 });
  assert.deepEqual(config.projects["caps"], {
    path: join(homedir(), "inkling-umbrella/caps"),
    check: "bin/ci",
    onlyTouchedTests: true,
  });
});

test("loadConfig: an unknown top-level table is refused with conversion instructions", () => {
  const recordHome = makeTestHome(`
    [spending-app]
    path = "~/inkling-umbrella/spending-app"
    check = "bin/ci"
  `);

  assert.throws(
    () => loadConfig(recordHome),
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
  const recordHome = makeTestHome(`
    home = "/srv/x"
    stamped = 2024-01-01T00:00:00Z

    [projects.spending-app]
    path = "~/inkling-umbrella/spending-app"
    check = "bin/ci"
  `);

  assert.throws(
    () => loadConfig(recordHome),
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
  const recordHome = makeTestHome(`
    [projects.spending-app]
    path = "~/inkling-umbrella/spending-app"
    check = "bin/ci"
  `);

  const config = loadConfig(recordHome);
  assert.equal(
    config.projects["spending-app"].path,
    join(homedir(), "inkling-umbrella/spending-app")
  );
});

test("loadConfig: a bare ~ project path is the home directory itself", () => {
  const recordHome = makeTestHome(`
    [projects.home-app]
    path = "~"
    check = "bin/ci"
  `);

  const config = loadConfig(recordHome);
  assert.equal(config.projects["home-app"].path, homedir());
});

test("loadConfig: a ~ anywhere but the start is left verbatim", () => {
  const recordHome = makeTestHome(`
    [projects.tilde-app]
    path = "/srv/back~ups/tilde-app"
    check = "bin/ci"

    [projects.nested-app]
    path = "/srv/~/nested-app"
    check = "bin/ci"
  `);

  const config = loadConfig(recordHome);
  assert.equal(config.projects["tilde-app"].path, "/srv/back~ups/tilde-app");
  assert.equal(config.projects["nested-app"].path, "/srv/~/nested-app");
});

test("loadConfig: no projects.toml at the given home fails with the exact path", () => {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-config-test-empty-"));

  assert.throws(
    () => loadConfig(recordHome),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, "not-found");
      assert.match(err.message, new RegExp(join(recordHome, "projects.toml").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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
  const recordHome = makeTestHome(`this is not [valid toml`);

  assert.throws(
    () => loadConfig(recordHome),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, "malformed");
      return true;
    }
  );
});

// Everything that re-prints this refusal now prints it on ONE line -
// `fabrica doctor`'s FAIL line, `fabrica status`'s first line, the live
// view's banner - so the path and the line the parser stopped on have to
// be in that one line, not buried in a code block underneath it.
test("loadConfig: an unparseable projects.toml names the file and the exact line, on one line", () => {
  const recordHome = makeTestHome(`[caps]\nperTaskUsd = 2.5\nthis is not [valid toml\n`);

  assert.throws(
    () => loadConfig(recordHome),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, "malformed");
      // Line 3 is where the broken line actually is - not line 1, and
      // not "somewhere in this file".
      assert.equal(err.line, 3);
      assert.equal(err.message.split("\n").length, 1, `expected one line, got: ${JSON.stringify(err.message)}`);
      assert.ok(err.message.startsWith(`${projectsTomlPath(recordHome)}:3:`), err.message);
      assert.match(err.message, /not valid TOML/);
      // The parser's own reason survives; its "Invalid TOML document:"
      // preamble does not, since the path above already says which file.
      assert.doesNotMatch(err.message, /Invalid TOML document/);
      return true;
    }
  );
});

// Only a parse failure has one line to point at. A file that parsed
// fine but names an unknown field has a table and a field instead, and
// must not claim a line number it does not have.
test("loadConfig: a refusal that isn't a parse failure carries no line number", () => {
  const recordHome = makeTestHome(`[caps]\nperTaskUsd = 2.5\nnonsense = true\n`);

  assert.throws(
    () => loadConfig(recordHome),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, "malformed");
      assert.equal(err.line, null);
      return true;
    }
  );
});

test("loadConfigOrProblem: a good file loads with no problem reported", () => {
  const recordHome = makeTestHome(`[caps]\nperTaskUsd = 2.5\n`);

  const { config, problem } = loadConfigOrProblem(recordHome);

  assert.equal(problem, null);
  assert.deepEqual(config.caps, { perTaskUsd: 2.5 });
});

// No projects.toml at all is ordinary, not a problem: no file means no
// registered projects and no caps, which is how every caller has always
// treated it.
test("loadConfigOrProblem: a missing projects.toml is the empty config, not a problem", () => {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-config-missing-"));

  const { config, problem } = loadConfigOrProblem(recordHome);

  assert.equal(problem, null);
  assert.deepEqual(config.caps, {});
  assert.deepEqual(config.projects, {});
  assert.deepEqual(config.pause, DEFAULT_PAUSE_RULE);
});

// The whole point of this reader: a caller that must keep working gets
// usable defaults AND the problem to show - never one without the other,
// and never a silent fallback.
test("loadConfigOrProblem: an unparseable projects.toml yields defaults plus the problem, path and line", () => {
  const recordHome = makeTestHome(`[caps]\nperTaskUsd = 2.5\nthis is not [valid toml\n`);

  const { config, problem } = loadConfigOrProblem(recordHome);

  assert.ok(problem, "a file that will not parse must report a problem");
  assert.equal(problem.path, projectsTomlPath(recordHome));
  assert.equal(problem.line, 3);
  assert.ok(problem.message.includes(projectsTomlPath(recordHome)), problem.message);
  // The defaults, so the caller can still render - the caps are empty
  // rather than half-read from a file nobody could parse.
  assert.deepEqual(config.caps, {});
  assert.deepEqual(config.projects, {});
  assert.deepEqual(config.pause, DEFAULT_PAUSE_RULE);
});

test("loadConfig: a project table missing path is refused as malformed", () => {
  const recordHome = makeTestHome(`
    [projects.spending-app]
    check = "bin/ci"
  `);

  assert.throws(
    () => loadConfig(recordHome),
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
  const recordHome = makeTestHome(`
    [caps]
    perTaskUsd = 0
    perDayUsd = 0
  `);

  const config = loadConfig(recordHome);
  assert.deepEqual(config.caps, { perTaskUsd: 0, perDayUsd: 0 });
});

test("loadConfig: a negative cap is refused as malformed", () => {
  const recordHome = makeTestHome(`
    [caps]
    perTaskUsd = -5
  `);

  assert.throws(
    () => loadConfig(recordHome),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, "malformed");
      assert.match(err.message, /perTaskUsd/);
      return true;
    }
  );
});

test("loadConfig: a non-finite cap is refused as malformed", () => {
  const recordHome = makeTestHome(`
    [caps]
    perDayUsd = inf
  `);

  assert.throws(
    () => loadConfig(recordHome),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, "malformed");
      assert.match(err.message, /perDayUsd/);
      return true;
    }
  );
});

test("loadConfig: a non-numeric cap is refused as malformed", () => {
  const recordHome = makeTestHome(`
    [caps]
    perDayUsd = "twenty"
  `);

  assert.throws(
    () => loadConfig(recordHome),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, "malformed");
      assert.match(err.message, /perDayUsd/);
      return true;
    }
  );
});

test("loadConfig: a project's allowed hosts and relay limits load as declared", () => {
  const recordHome = makeTestHome(`
    [projects.spending-app]
    path = "~/inkling-umbrella/spending-app"
    check = "bin/ci"
    hosts = ["registry.npmjs.org", "*.example.com:8443"]
    maxRequestBytes = 1048576
    maxCallsPerTask = 50
  `);

  assert.deepEqual(loadConfig(recordHome).projects["spending-app"], {
    path: join(homedir(), "inkling-umbrella/spending-app"),
    check: "bin/ci",
    hosts: ["registry.npmjs.org", "*.example.com:8443"],
    maxRequestBytes: 1048576,
    maxCallsPerTask: 50,
    onlyTouchedTests: true,
  });
});

test("loadConfig: a project that declares no hosts carries none - the defaults are not written in here", () => {
  const recordHome = makeTestHome(`
    [projects.spending-app]
    path = "~/inkling-umbrella/spending-app"
    check = "bin/ci"
  `);

  const project = loadConfig(recordHome).projects["spending-app"];
  assert.equal(project.hosts, undefined);
  assert.equal(project.maxRequestBytes, undefined);
  assert.equal(project.maxCallsPerTask, undefined);
});

test("loadConfig: hosts must be an array of strings", () => {
  for (const hosts of [`"registry.npmjs.org"`, `[1, 2]`, `["registry.npmjs.org", ""]`]) {
    const recordHome = makeTestHome(`
      [projects.spending-app]
      path = "~/app"
      hosts = ${hosts}
    `);

    assert.throws(
      () => loadConfig(recordHome),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError);
        assert.equal(err.code, "malformed");
        assert.match(err.message, /hosts/);
        return true;
      },
      `hosts = ${hosts} should have been refused`
    );
  }
});

test("loadConfig: a relay limit must be a whole number of at least 1", () => {
  for (const line of ["maxRequestBytes = 0", "maxRequestBytes = 1.5", `maxCallsPerTask = "lots"`, "maxCallsPerTask = -1"]) {
    const recordHome = makeTestHome(`
      [projects.spending-app]
      path = "~/app"
      ${line}
    `);

    assert.throws(
      () => loadConfig(recordHome),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError);
        assert.equal(err.code, "malformed");
        assert.match(err.message, /max(RequestBytes|CallsPerTask)/);
        return true;
      },
      `${line} should have been refused`
    );
  }
});

// Issue #142: the Client's standing ruling, so the loader applies it to
// every entry - including every entry written before the field existed.
test("loadConfig: onlyTouchedTests defaults to true and can be turned off per project", () => {
  const recordHome = makeTestHome(`
    [projects.default-app]
    path = "/srv/default-app"

    [projects.opted-out]
    path = "/srv/opted-out"
    onlyTouchedTests = false

    [projects.explicit]
    path = "/srv/explicit"
    onlyTouchedTests = true
  `);

  const { projects } = loadConfig(recordHome);
  assert.equal(projects["default-app"].onlyTouchedTests, true);
  assert.equal(projects["opted-out"].onlyTouchedTests, false);
  assert.equal(projects["explicit"].onlyTouchedTests, true);
});

test("loadConfig: a non-boolean onlyTouchedTests is refused as malformed, never read as off", () => {
  for (const value of [`"false"`, "0", "[true]"]) {
    const recordHome = makeTestHome(`
      [projects.spending-app]
      path = "~/app"
      onlyTouchedTests = ${value}
    `);

    assert.throws(
      () => loadConfig(recordHome),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError);
        assert.equal(err.code, "malformed");
        assert.match(err.message, /onlyTouchedTests/);
        return true;
      },
      `onlyTouchedTests = ${value} should have been refused`
    );
  }
});

test("loadConfig: an unknown project field still names every field that is recognized", () => {
  const recordHome = makeTestHome(`
    [projects.spending-app]
    path = "~/app"
    allowedHosts = ["registry.npmjs.org"]
  `);

  assert.throws(
    () => loadConfig(recordHome),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /allowedHosts/);
      assert.match(err.message, /hosts/);
      return true;
    }
  );
});

// Issue #189's [pause] table: the subscription meters' thresholds.

test("loadConfig: no [pause] table at all still yields the pause rule's defaults, not nothing", () => {
  const home = makeTestHome(`[caps]\nperDayUsd = 25\n`);
  assert.deepEqual(loadConfig(home).pause, DEFAULT_PAUSE_RULE);
  assert.equal(loadConfig(home).pause.sevenDayRefusePercent, 70);
  assert.equal(loadConfig(home).pause.sevenDayStopPercent, 90);
  assert.equal(loadConfig(home).pause.fiveHourRefusePercent, 90);
});

test("loadConfig: a [pause] table overrides only the thresholds it names", () => {
  const home = makeTestHome(`[pause]\nfiveHourRefusePercent = 50\n`);
  const { pause } = loadConfig(home);
  assert.equal(pause.fiveHourRefusePercent, 50);
  assert.equal(pause.sevenDayRefusePercent, DEFAULT_PAUSE_RULE.sevenDayRefusePercent);
  assert.equal(pause.sevenDayStopPercent, DEFAULT_PAUSE_RULE.sevenDayStopPercent);
});

test("loadConfig: a pause threshold outside 0-100 is refused as malformed", () => {
  for (const bad of ["101", "-1", '"70"']) {
    assert.throws(
      () => loadConfig(makeTestHome(`[pause]\nsevenDayRefusePercent = ${bad}\n`)),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError);
        assert.equal(err.code, "malformed");
        assert.match(err.message, /percentage from 0 to 100/);
        return true;
      }
    );
  }
});

test("loadConfig: a global [reviewer] table loads", () => {
  const recordHome = makeTestHome(`
    [reviewer]
    vendor = "reviewing-vendor"
    model = "reviewing-model"

    [projects.spending-app]
    path = "~/app"
    check = "bin/ci"
  `);

  const config = loadConfig(recordHome);

  assert.deepEqual(config.reviewer, { vendor: "reviewing-vendor", model: "reviewing-model" });
  assert.equal(config.projects["spending-app"].reviewer, undefined, "a project inherits rather than copies");
});

test("loadConfig: no [reviewer] table at all is not an error", () => {
  const recordHome = makeTestHome(`
    [projects.spending-app]
    path = "~/app"
    check = "bin/ci"
  `);

  assert.equal(loadConfig(recordHome).reviewer, undefined);
});

test("loadConfig: a project may carry its own reviewer alongside the global one", () => {
  const recordHome = makeTestHome(`
    [reviewer]
    vendor = "global-vendor"
    model = "global-model"

    [projects.spending-app]
    path = "~/app"
    check = "bin/ci"

    [projects.spending-app.reviewer]
    vendor = "project-vendor"
    model = "project-model"
  `);

  const config = loadConfig(recordHome);

  assert.deepEqual(config.reviewer, { vendor: "global-vendor", model: "global-model" });
  assert.deepEqual(config.projects["spending-app"].reviewer, { vendor: "project-vendor", model: "project-model" });
  assert.equal(config.projects["spending-app"].check, "bin/ci", "the rest of the entry still parses");
});

test("loadConfig: half a reviewer is refused rather than quietly ignored", () => {
  for (const table of [`vendor = "v"`, `model = "m"`, `vendor = "v"\n    model = ""`, `vendor = 7\n    model = "m"`]) {
    const recordHome = makeTestHome(`
    [reviewer]
    ${table}
  `);

    assert.throws(
      () => loadConfig(recordHome),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError);
        assert.equal(err.code, "malformed");
        assert.match(err.message, /\[reviewer\]\.(vendor|model)/);
        return true;
      },
      `${table} should have been refused`
    );
  }
});

test("loadConfig: a stop threshold below the refuse threshold is refused - it could only be a mistake", () => {
  assert.throws(
    () => loadConfig(makeTestHome(`[pause]\nsevenDayRefusePercent = 80\nsevenDayStopPercent = 60\n`)),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /below \[pause\].sevenDayRefusePercent/);
      return true;
    }
  );
});

test("loadConfig: an unknown reviewer field is refused, and the refusal names where it was", () => {
  const recordHome = makeTestHome(`
    [projects.spending-app]
    path = "~/app"

    [projects.spending-app.reviewer]
    vendor = "v"
    model = "m"
    apiKey = "never-here"
  `);

  assert.throws(
    () => loadConfig(recordHome),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, "malformed");
      assert.match(err.message, /\[projects\.spending-app\.reviewer\]/);
      assert.match(err.message, /apiKey/);
      return true;
    }
  );
});

test("loadConfig: an unknown [pause] field names every field that is recognized", () => {
  assert.throws(
    () => loadConfig(makeTestHome(`[pause]\nsevenDayPercent = 70\n`)),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /sevenDayRefusePercent, sevenDayStopPercent and fiveHourRefusePercent/);
      return true;
    }
  );
});

test("loadConfig: the unknown-top-level-table message points at [reviewer] as a global too", () => {
  const recordHome = makeTestHome(`
    [spending-app]
    path = "~/app"
  `);

  assert.throws(
    () => loadConfig(recordHome),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /\[reviewer\]/);
      return true;
    }
  );
});

test("loadConfig: [pause] is a known top-level table, never reported as a stale project", () => {
  // Before issue #189 this would have been refused as an unknown
  // top-level table and suggested for renaming to [projects.pause].
  assert.doesNotThrow(() => loadConfig(makeTestHome(`[pause]\nsevenDayRefusePercent = 70\n`)));
});
