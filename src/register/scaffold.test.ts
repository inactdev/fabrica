import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkScript, inspectorConfigJson, protectedPathsFor } from "./scaffold.ts";
import { dependencyShapeFrom } from "./dockerfile.ts";
import { RAILS_GEMFILE_LOCK } from "./helpers/rails-fixture.ts";
import { RECORDED_CHECK } from "./origin.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The Ruby shape of a Rails application: both servers, and a test
 * database to create. */
function railsShape() {
  return dependencyShapeFrom({
    packageLock: false,
    goSum: false,
    gemfileLock: RAILS_GEMFILE_LOCK,
    rubyVersionFile: true,
    railsBin: true,
  });
}

test("protectedPathsFor always protects the gate, its definition and the box it runs in", () => {
  assert.deepEqual(protectedPathsFor([]), ["check.sh", ".inspector.json", "Dockerfile.inspector"]);
});

test("protectedPathsFor: --protected adds to those three rather than replacing them", () => {
  assert.deepEqual(protectedPathsFor(["*.test.ts", "contract/**"]), [
    "check.sh",
    ".inspector.json",
    "Dockerfile.inspector",
    "*.test.ts",
    "contract/**",
  ]);
});

test("protectedPathsFor: naming one of the defaults again does not duplicate it", () => {
  assert.deepEqual(protectedPathsFor([".inspector.json", "Dockerfile.inspector", "docs/**"]), [
    "check.sh",
    ".inspector.json",
    "Dockerfile.inspector",
    "docs/**",
  ]);
});

// Every path register always protects is one this repository's own
// config protects too - the only live evidence of what Inspector acts
// on. Dockerfile.inspector joined that list with inspector#47, since the
// check box is built from it (issue #303's clarification).
test("protectedPathsFor's defaults are all paths this repository's own .inspector.json protects", () => {
  const ours = JSON.parse(readFileSync(join(repoRoot, ".inspector.json"), "utf8")) as {
    protectedPaths?: string[];
  };
  for (const path of protectedPathsFor([])) {
    assert.ok(
      (ours.protectedPaths ?? []).includes(path),
      `${path} is protected by register but not by this repository's own .inspector.json`
    );
  }
});

// The schema here is this repository's own .inspector.json - a live
// config the real Inspector acts on. Only keys it actually shows are
// ever written, which is what inspector#47 broke for `image`/`network`
// and what this proves is fixed.
test("inspectorConfigJson writes only keys this repository's own .inspector.json uses", () => {
  const config = JSON.parse(inspectorConfigJson({ protectedPaths: ["check.sh"] }));
  assert.deepEqual(Object.keys(config).sort(), ["check", "protectedPaths"]);

  const ours = JSON.parse(readFileSync(join(repoRoot, ".inspector.json"), "utf8")) as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    assert.ok(
      Object.hasOwn(ours, key),
      `${key} is not a key this repository's own .inspector.json uses - the only evidence of the schema there is`
    );
  }
});

// inspector#47 retired both keys, with any value: the check box is built
// from Dockerfile.inspector and has no network, so there is nothing for
// either of them to say.
test("inspectorConfigJson writes no image and no network key, whatever it is asked for", () => {
  for (const config of [
    inspectorConfigJson(),
    inspectorConfigJson({ protectedPaths: [] }),
    inspectorConfigJson({ check: "npm test", protectedPaths: ["check.sh"], timeoutSeconds: 1200 }),
  ]) {
    const parsed = JSON.parse(config) as Record<string, unknown>;
    assert.equal(Object.hasOwn(parsed, "image"), false, config);
    assert.equal(Object.hasOwn(parsed, "network"), false, config);
  }
});

test("inspectorConfigJson: --timeout is written only when asked for", () => {
  const plain = JSON.parse(inspectorConfigJson({ protectedPaths: [] }));
  assert.equal(Object.hasOwn(plain, "timeoutSeconds"), false, "no --timeout leaves Inspector's own default");

  const full = JSON.parse(inspectorConfigJson({ protectedPaths: [], timeoutSeconds: 1200 }));
  assert.equal(full.timeoutSeconds, 1200);
});

// Same provenance rule as above, applied to the one key a flag writes:
// this repository's own config is the only evidence of it.
test("inspectorConfigJson: timeoutSeconds is a key this repository's own config uses", () => {
  const ours = JSON.parse(readFileSync(join(repoRoot, ".inspector.json"), "utf8")) as Record<string, unknown>;
  const full = JSON.parse(inspectorConfigJson({ protectedPaths: ["check.sh"], timeoutSeconds: 60 }));

  assert.deepEqual(Object.keys(full).sort(), ["check", "protectedPaths", "timeoutSeconds"]);
  for (const key of Object.keys(full)) {
    assert.ok(Object.hasOwn(ours, key), `${key} is not a key this repository's own .inspector.json uses`);
  }
  assert.equal(typeof ours.timeoutSeconds, typeof full.timeoutSeconds, "and the same type it uses it with");
});

test("inspectorConfigJson names ./check.sh as the check, whatever the command was", () => {
  const config = JSON.parse(inspectorConfigJson({ protectedPaths: [] }));
  assert.equal(config.check, RECORDED_CHECK);
});

test("inspectorConfigJson is pretty-printed with a trailing newline - a file a human edits later", () => {
  const text = inspectorConfigJson({ protectedPaths: ["check.sh"] });
  assert.ok(text.endsWith("\n"));
  assert.ok(text.includes("\n  "), "should be indented, not a single-line blob");
});

test("checkScript holds the command verbatim, under a shebang and set -e", () => {
  const script = checkScript("npm run lint && npm test");
  assert.ok(script.startsWith("#!/bin/sh\n"));
  assert.ok(script.includes("\nset -e\n"));
  assert.ok(script.endsWith("npm run lint && npm test\n"));
});

test("checkScript says where it came from, for whoever reads it next", () => {
  const script = checkScript("npm test");
  assert.ok(script.includes("fabrica register"));
  assert.ok(script.includes("Inspector runs this file"));
});

// The other half of the Dockerfile's install step: the check box has no
// network, so a node_modules nothing links in is a node_modules that is
// never there. This repository's own check.sh is the reference shape.
test("checkScript links in what the check image baked, for a package-lock.json project", () => {
  const npm = dependencyShapeFrom({ packageLock: true, goSum: false });
  const script = checkScript("npm test", npm);

  assert.ok(script.includes(`cd "$(dirname "$0")"`), script);
  assert.ok(script.includes("[ -d /deps/node_modules ]"), script);
  assert.ok(script.includes("ln -s /deps/node_modules node_modules"), script);
  // ...and still runs for real anywhere else - a laptop, a worker's own
  // box, register's own proving run, all of which have a network and no
  // /deps.
  assert.ok(script.includes("npm ci"), script);
  assert.ok(script.endsWith("npm test\n"), script);
});

// A Go module's cache lives outside the checkout, so nothing has to be
// linked in and the script stays the bare command.
test("checkScript adds no preamble for a shape whose dependencies need no link", () => {
  const go = dependencyShapeFrom({ packageLock: false, goSum: true });
  assert.equal(checkScript("go test ./...", go), checkScript("go test ./..."));
});

// ------------------------------- the Ruby shape's own preamble (#324)

test("checkScript: a Ruby shape with no servers is still just the command", () => {
  const plain = dependencyShapeFrom({ packageLock: false, goSum: false, gemfileLock: "GEM\n  specs:\n    rake (13)\n" });

  assert.equal(checkScript("bundle exec rspec", plain), checkScript("bundle exec rspec"));
});

test("checkScript: the servers are started, waited for, stopped, and the command still comes last", () => {
  const script = checkScript("bundle exec rspec", railsShape());

  assert.ok(script.includes("service postgresql start\n"), script);
  assert.ok(script.includes("wait_for PostgreSQL pg_isready -q\n"), script);
  assert.ok(script.includes(`redis-server --daemonize yes --save ''\n`), script);
  assert.ok(script.includes("wait_for Redis redis-cli ping\n"), script);
  // Stopped however the script ends, including a failing suite - and the
  // trap runs no exit of its own, so the suite's status survives it.
  assert.ok(script.includes("trap stop_services EXIT\n"), script);
  assert.ok(script.includes("service postgresql stop"), script);
  assert.ok(script.includes("redis-cli shutdown nosave"), script);
  assert.ok(!/^\s*exit /m.test(script.split("stop_services() {")[1].split("}")[0]), "the trap must not exit");
  // The test database, then the suite, in that order and last.
  assert.ok(script.indexOf("bin/rails db:test:prepare") < script.indexOf("bundle exec rspec\n"), script);
  assert.ok(script.endsWith("bundle exec rspec\n"), script);
});

/**
 * The preamble, genuinely executed - the one thing a generated shell
 * script can be wrong about in a way no substring assertion would
 * catch. Every outside command it names is stubbed onto `PATH`,
 * appending to a log, so this proves the order, the waiting loop, the
 * trap and the exit status for real, under this machine's own `/bin/sh`.
 *
 * It proves nothing about PostgreSQL, Redis or Rails themselves: those
 * need the built image, which is Inspector's to build. What it does
 * prove is that the script around them is a working script.
 */
function runGeneratedCheck(opts: { suite: string; suiteExit: number; readyAfter?: number }): {
  status: number;
  log: string[];
} {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-checkscript-"));
  const bin = join(dir, "stubs");
  mkdirSync(bin);
  mkdirSync(join(dir, "bin"));
  const log = join(dir, "log");

  // `pg_isready` fails the first `readyAfter` times, so the waiting loop
  // is a loop that genuinely waits rather than one that happens to be
  // satisfied on its first pass.
  const stub = (name: string, body: string) => {
    const path = name === "bin/rails" ? join(dir, name) : join(bin, name);
    writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(path, 0o755);
  };
  stub("service", "exit 0");
  stub(
    "pg_isready",
    `tries=$(cat "${join(dir, "tries")}" 2>/dev/null || echo 0)\n` +
      `echo $((tries + 1)) > "${join(dir, "tries")}"\n` +
      `[ "$tries" -ge ${opts.readyAfter ?? 0} ]`
  );
  stub("redis-server", "exit 0");
  stub("redis-cli", "exit 0");
  stub("bin/rails", "exit 0");
  stub("bundle", `exit ${opts.suiteExit}`);

  writeFileSync(join(dir, "check.sh"), checkScript(opts.suite, railsShape()));
  chmodSync(join(dir, "check.sh"), 0o755);

  const run = spawnSync("/bin/sh", [join(dir, "check.sh")], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
  });

  return {
    status: run.status ?? -1,
    log: (readFileSync(log, "utf8").trim().split("\n") ?? []).filter((line) => line.length > 0),
  };
}

test("the generated check.sh really runs: servers up, database prepared, suite run, servers stopped", () => {
  const { status, log } = runGeneratedCheck({ suite: "bundle exec rspec", suiteExit: 0, readyAfter: 2 });

  assert.equal(status, 0, log.join("\n"));
  assert.deepEqual(
    log.filter((line) => !line.startsWith("pg_isready")),
    [
      "service postgresql start",
      "redis-server --daemonize yes --save ",
      "redis-cli ping",
      "bin/rails db:test:prepare",
      "bundle exec rspec",
      "service postgresql stop",
      "redis-cli shutdown nosave",
    ]
  );
  // The wait is a real wait: pg_isready refused twice before answering,
  // and the script kept asking rather than carrying on regardless.
  assert.equal(log.filter((line) => line.startsWith("pg_isready")).length, 3, log.join("\n"));
});

// The half a `set -e` script gets wrong on its own: a failing suite
// exits before any cleanup, leaving both servers running - and a trap
// that cleans up can just as easily swallow the failure.
test("the generated check.sh stops the servers after a failing suite, and still fails", () => {
  const { status, log } = runGeneratedCheck({ suite: "bundle exec rspec", suiteExit: 3 });

  assert.equal(status, 3, "the suite's own status is the check's status");
  assert.ok(log.includes("service postgresql stop"), log.join("\n"));
  assert.ok(log.includes("redis-cli shutdown nosave"), log.join("\n"));
});
