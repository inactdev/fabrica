import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkCommandFor,
  checkScript,
  inspectorConfigJson,
  protectedPathsFor,
  type TermsLocation,
} from "./scaffold.ts";
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

  assert.ok(script.includes(`$PGBIN/initdb' --username='$PGUSER' --auth=trust`), script);
  assert.ok(script.includes(`wait_for PostgreSQL "$PGBIN/pg_isready" -q -h "$PGHOST"\n`), script);
  assert.ok(script.includes(`redis-server --daemonize yes --save '' --appendonly no`), script);
  assert.ok(script.includes("wait_for Redis redis-cli ping\n"), script);
  // Stopped however the script ends, including a failing suite - and the
  // trap runs no exit of its own, so the suite's status survives it.
  assert.ok(script.includes("trap fabrica_cleanup EXIT\n"), script);
  assert.ok(script.includes("pg_ctl' -D '$PGDATA' -m fast -w stop"), script);
  assert.ok(script.includes("redis-cli shutdown nosave"), script);
  assert.ok(!/^\s*exit /m.test(script.split("fabrica_cleanup() {")[1].split("}")[0]), "the trap must not exit");
  // The test database, then the suite, in that order and last.
  assert.ok(script.indexOf("bin/rails db:test:prepare") < script.indexOf("bundle exec rspec\n"), script);
  assert.ok(script.endsWith("bundle exec rspec\n"), script);
});

// ------------------------- issue #337: what the check box actually is

// Every top-level path the repository tracks is mounted read-only in the
// check box, directories included - so a Rails application's log/ and
// tmp/ cannot be written at all. Nothing this script writes may be
// inside the checkout.
test("checkScript: everything a Rails check writes goes in a scratch directory, removed on the way out", () => {
  const script = checkScript("bundle exec rspec", railsShape());

  assert.ok(script.includes(`FABRICA_STATE=$(mktemp -d "\${TMPDIR:-/tmp}/fabrica-check-XXXXXX")\n`), script);
  assert.ok(script.includes(`  rm -rf "$FABRICA_STATE"\n`), script);
  // The two Rails writes that would otherwise land in the checkout.
  assert.ok(script.includes(`BOOTSNAP_CACHE_DIR=$FABRICA_STATE/bootsnap\n`), script);
  assert.ok(script.includes(`TMPDIR=$FABRICA_STATE/tmp\n`), script);
  // Every path the servers write to is under it too - the data
  // directory, both sockets, every log and pidfile.
  for (const path of [
    `PGDATA=$FABRICA_STATE/postgres/data`,
    `PGHOST=$FABRICA_STATE/postgres/socket`,
    `$FABRICA_STATE/postgres/initdb.log`,
    `$FABRICA_STATE/postgres/server.log`,
    `--dir "$FABRICA_STATE/redis"`,
    `--pidfile "$FABRICA_STATE/redis/redis.pid"`,
    `--logfile "$FABRICA_STATE/redis/redis.log"`,
  ]) {
    assert.ok(script.includes(path), `${path} is not under the scratch directory:\n${script}`);
  }
  // The environment has to be set before anything boots the
  // application, and db:test:prepare boots it too.
  assert.ok(script.indexOf("BOOTSNAP_CACHE_DIR=") < script.indexOf("bin/rails db:test:prepare"), script);
});

// Inspector runs the check as the uid of whoever invoked it - no
// /etc/passwd entry - so nothing about PostgreSQL can be settled at
// build time: the cluster has to be created here, by whoever is running,
// and authentication cannot be the "peer" default that needs a user
// name.
test("checkScript: the cluster is created at check time, and never relies on a user name", () => {
  const script = checkScript("bundle exec rspec", railsShape());

  assert.ok(script.includes("--auth=trust"), script);
  assert.doesNotMatch(script, /createuser/, script);
  assert.doesNotMatch(script, /service postgresql/, script);
  // PGUSER exported, because libpq's own default comes from the uid's
  // passwd entry as well.
  assert.ok(script.includes("export PGDATA PGHOST PGUSER\n"), script);
  // The server binaries are found, not pinned to a major version, and a
  // box without them fails here rather than on a connection error.
  assert.ok(script.includes("PGBIN=$(ls -d /usr/lib/postgresql/*/bin"), script);
  assert.ok(script.includes(`if [ ! -x "$PGBIN/initdb" ]; then`), script);
  // pg_isready through PGBIN too: /usr/bin/pg_isready is Debian's
  // pg_wrapper, which wants a cluster configuration this one is not.
  assert.doesNotMatch(script, /wait_for PostgreSQL pg_isready/, script);
});

test("checkScript: a terms folder's script never cds to its own folder, and says why", () => {
  const script = checkScript("bundle exec rspec", railsShape(), "folder");

  assert.doesNotMatch(script, /cd "\$\(dirname "\$0"\)"\n/, script);
  assert.ok(script.includes("/terms"), script);
  assert.ok(script.includes("/workspace"), script);
  // The repository route is unchanged, and still does cd.
  assert.ok(checkScript("bundle exec rspec", railsShape()).includes(`cd "$(dirname "$0")"\n`));
});

test("inspectorConfigJson: a terms folder's check names the script where Inspector mounts it", () => {
  assert.equal(JSON.parse(inspectorConfigJson({ terms: "folder" })).check, "sh /terms/check.sh");
  assert.equal(JSON.parse(inspectorConfigJson({ terms: "repository" })).check, RECORDED_CHECK);
  assert.equal(JSON.parse(inspectorConfigJson()).check, RECORDED_CHECK);
  assert.equal(checkCommandFor("folder"), "sh /terms/check.sh");
  assert.equal(checkCommandFor("repository"), RECORDED_CHECK);
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
function runGeneratedCheck(opts: {
  suite: string;
  suiteExit: number;
  readyAfter?: number;
  terms?: TermsLocation;
  /** What the stubbed `id -u` answers, i.e. which branch of `pg_as` the
   * script takes for real. `0` is the rootless-Docker case, where
   * Inspector runs the check as root inside the container's own user
   * namespace, and `initdb`/`postgres` both refuse to be root. */
  uid?: number;
}): { status: number; log: string[]; stderr: string; scratchDirs: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-checkscript-"));
  const bin = join(dir, "stubs");
  mkdirSync(bin);
  mkdirSync(join(dir, "bin"));
  const log = join(dir, "log");
  const pgbin = join(dir, "pgbin");
  mkdirSync(pgbin);

  // `pg_isready` fails the first `readyAfter` times, so the waiting loop
  // is a loop that genuinely waits rather than one that happens to be
  // satisfied on its first pass.
  const stub = (name: string, body: string) => {
    const path = name.includes("/") ? join(dir, name) : join(bin, name);
    writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(path, 0o755);
  };
  stub(
    "pgbin/pg_isready",
    `tries=$(cat "${join(dir, "tries")}" 2>/dev/null || echo 0)\n` +
      `echo $((tries + 1)) > "${join(dir, "tries")}"\n` +
      `[ "$tries" -ge ${opts.readyAfter ?? 0} ]`
  );
  stub("pgbin/initdb", "exit 0");
  stub("pgbin/postgres", "exit 0");
  stub("pgbin/pg_ctl", "exit 0");
  stub("redis-server", "exit 0");
  stub("redis-cli", "exit 0");
  stub("bin/rails", "exit 0");
  stub("bundle", `exit ${opts.suiteExit}`);
  // The two commands only the root branch reaches. `su` runs what it was
  // given, so the script's own `sh -c` body still executes either way -
  // which is the point: both branches have to really work.
  stub("id", `echo ${opts.uid ?? 1001}`);
  stub("chown", "exit 0");
  stub("su", `shift 4\nexec /bin/sh -c "$1"`);

  // The one line that has to be rewritten rather than stubbed: the
  // script globs Debian's own /usr/lib/postgresql, which no test may
  // write into. Everything else about the PostgreSQL block - the
  // guard, the quoting through pg_as, the backgrounded start, the stop
  // in the trap - runs exactly as generated.
  const generated = checkScript(opts.suite, railsShape(), opts.terms ?? "repository").replace(
    "PGBIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -n 1)",
    `PGBIN=${pgbin}`
  );
  writeFileSync(join(dir, "check.sh"), generated);
  chmodSync(join(dir, "check.sh"), 0o755);

  const run = spawnSync("/bin/sh", [join(dir, "check.sh")], {
    encoding: "utf8",
    cwd: dir,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
  });

  return {
    status: run.status ?? -1,
    stderr: run.stderr,
    log: (readFileSync(log, "utf8").trim().split("\n") ?? []).filter((line) => line.length > 0),
    // Whatever the script made under the temporary directory it chose -
    // read after it exited, so this is what survived its own cleanup.
    scratchDirs: readdirSync(tmpdir()).filter((name) => name.startsWith("fabrica-check-")),
  };
}

/** The order of the real steps, with the readiness polling and the
 * root-only `id`/`chown`/`su` bookkeeping filtered out: those are
 * asserted separately, by their own tests. */
function steps(log: string[]): string[] {
  return log.filter((line) => !/^(?:pgbin\/pg_isready|id|chown|su)\b/.test(line));
}

test("the generated check.sh really runs: servers up, database prepared, suite run, servers stopped", () => {
  const { status, log } = runGeneratedCheck({ suite: "bundle exec rspec", suiteExit: 0, readyAfter: 2 });

  assert.equal(status, 0, log.join("\n"));
  // Every real step, in order: the cluster created, the server started,
  // Redis started and answering, the test database loaded, the suite
  // run, then both servers stopped by the trap.
  const expected = [
    /^pgbin\/initdb --username=postgres --auth=trust -D /,
    /^pgbin\/postgres -D /,
    /^redis-server --daemonize yes --save {2}--appendonly no --dir /,
    /^redis-cli ping$/,
    /^bin\/rails db:test:prepare$/,
    /^bundle exec rspec$/,
    /^pgbin\/pg_ctl -D .* -m fast -w stop$/,
    /^redis-cli shutdown nosave$/,
  ];
  const actual = steps(log);
  assert.equal(actual.length, expected.length, actual.join("\n"));
  for (const [index, pattern] of expected.entries()) {
    assert.match(actual[index], pattern, `step ${index} of:\n${actual.join("\n")}`);
  }
  // The wait is a real wait: pg_isready refused twice before answering,
  // and the script kept asking rather than carrying on regardless.
  assert.equal(log.filter((line) => line.startsWith("pgbin/pg_isready")).length, 3, log.join("\n"));
});

// The half a `set -e` script gets wrong on its own: a failing suite
// exits before any cleanup, leaving both servers running - and a trap
// that cleans up can just as easily swallow the failure.
test("the generated check.sh stops the servers after a failing suite, and still fails", () => {
  const { status, log } = runGeneratedCheck({ suite: "bundle exec rspec", suiteExit: 3 });

  assert.equal(status, 3, "the suite's own status is the check's status");
  assert.ok(
    log.some((line) => line.startsWith("pgbin/pg_ctl")),
    log.join("\n")
  );
  assert.ok(log.includes("redis-cli shutdown nosave"), log.join("\n"));
});

// Issue #337. Not a hypothetical branch: under a rootless Docker daemon
// Inspector resolves the check's user to 0:0, and initdb and postgres
// both refuse to run as root - so under root the cluster has to be
// handed to the postgres system user and su'd to. Proven by running it,
// with `id` answering 0.
test("the generated check.sh runs the cluster as the postgres user when the box is root", () => {
  const { status, log } = runGeneratedCheck({ suite: "bundle exec rspec", suiteExit: 0, uid: 0 });

  assert.equal(status, 0, log.join("\n"));
  // Handed over first, su'd to second, and initdb still genuinely ran
  // through it.
  const chown = log.findIndex((line) => line.startsWith("chown -R postgres:postgres"));
  const su = log.findIndex((line) => line.startsWith("su postgres"));
  const initdb = log.findIndex((line) => line.startsWith("pgbin/initdb"));
  assert.ok(chown >= 0 && su >= 0 && initdb >= 0, log.join("\n"));
  assert.ok(chown < su && su < initdb, log.join("\n"));
  // And the suite still ran, in the same order as any other box.
  assert.ok(
    steps(log).some((line) => line === "bundle exec rspec"),
    log.join("\n")
  );
});

test("the generated check.sh fails loudly, and early, in a box with no PostgreSQL in it", () => {
  // The guard as generated, with nothing stubbed for it to find: the
  // real glob of /usr/lib/postgresql, which this machine has none of.
  const dir = mkdtempSync(join(tmpdir(), "fabrica-checkscript-"));
  writeFileSync(join(dir, "check.sh"), checkScript("bundle exec rspec", railsShape()));
  chmodSync(join(dir, "check.sh"), 0o755);
  const run = spawnSync("/bin/sh", [join(dir, "check.sh")], { encoding: "utf8", cwd: dir });

  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /no PostgreSQL server binaries under \/usr\/lib\/postgresql/);
  assert.match(run.stderr, /Dockerfile\.inspector/);
});

// The scratch directory is the whole answer to a read-only checkout, so
// it has to actually be gone afterwards - on the failing path too, which
// is the one a trap gets wrong.
test("the generated check.sh leaves no scratch directory behind, pass or fail", () => {
  const before = readdirSync(tmpdir()).filter((name) => name.startsWith("fabrica-check-"));
  for (const suiteExit of [0, 3]) {
    const { scratchDirs } = runGeneratedCheck({ suite: "bundle exec rspec", suiteExit });
    assert.deepEqual(scratchDirs, before, `a scratch directory survived an exit ${suiteExit}`);
  }
});
