import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
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

// Nothing else in the generated script says which environment this is,
// and `bin/rails db:test:prepare` boots the application to do its work:
// with no RAILS_ENV set it boots in development, which is a different
// database and a different gem group from the one the suite then runs
// in. The suite's own spec_helper only defaults RAILS_ENV for its own
// process, well after db:test:prepare has already run in another.
test("checkScript: a Rails check says it is a test run, before anything boots the application", () => {
  const script = checkScript("bundle exec rspec", railsShape());

  assert.ok(script.includes(`RAILS_ENV=test\n`), script);
  assert.ok(/^export .*\bRAILS_ENV\b/m.test(script), `RAILS_ENV has to be exported to reach bin/rails:\n${script}`);
  assert.ok(script.indexOf("RAILS_ENV=test") < script.indexOf("bin/rails db:test:prepare"), script);
  // A non-Rails shape has no environment to name, and must not grow one.
  const node = checkScript("npm test", dependencyShapeFrom({ packageLock: true, goSum: false }));
  assert.doesNotMatch(node, /RAILS_ENV/, node);
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
  // And the uid is given a name of its own before any of that, because
  // initdb looks its own uid up whatever it is told about roles.
  assert.ok(script.indexOf(`getent passwd "$fabrica_uid"`) < script.indexOf("PGBIN="), script);
});

// The box's uid is a property of the box, not of PostgreSQL, so the
// entry is written once for anything in there that looks a user up - and
// written by nothing at all for a shape with no such server, since a
// check that does not need it has no business touching /etc/passwd.
test("checkScript: only a shape that looks the user up writes a passwd entry", () => {
  const plain = dependencyShapeFrom({
    packageLock: false,
    goSum: false,
    gemfileLock: "GEM\n  specs:\n    redis (5.0.0)\n",
  });

  assert.ok(checkScript("bundle exec rspec", railsShape()).includes("/etc/passwd"), "the Rails shape needs it");
  assert.doesNotMatch(checkScript("bundle exec rspec", plain), /etc\/passwd/);
  assert.doesNotMatch(checkScript("npm test", dependencyShapeFrom({ packageLock: true, goSum: false })), /passwd/);
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
  /** Makes `initdb` fail, the way a box with a half-installed PostgreSQL
   * does - the case where the only explanation is in a log file inside
   * the scratch directory the cleanup removes. */
  initdbFails?: boolean;
  /** Whether the box's own uid is a stranger to `/etc/passwd`, which is
   * what Inspector's check box really is. Default is a uid with an
   * entry, so every other test here runs straight past that block and
   * stays about PostgreSQL. */
  uidHasNoEntry?: boolean;
  /** Points the script at a passwd/group pair it cannot write - the box
   * whose `Dockerfile.inspector` lost its `chmod` line. */
  passwdUnwritable?: boolean;
}): {
  status: number;
  log: string[];
  stderr: string;
  scratchDirs: string[];
  /** `/etc/passwd` and `/etc/group` as the script left them - a
   * throwaway pair of files per run, never the machine's own. */
  passwd: string;
  group: string;
  /** What `RAILS_ENV` actually was in `bin/rails`'s own environment,
   * recorded by the stub rather than read off the script's text: an
   * assignment that is never exported reaches nothing. */
  railsEnv: string;
} {
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
  stub(
    "pgbin/initdb",
    opts.initdbFails === true
      ? `echo "initdb: could not create directory, Permission denied" >&2\nexit 1`
      : "exit 0"
  );
  stub("pgbin/postgres", "exit 0");
  stub("pgbin/pg_ctl", "exit 0");
  stub("redis-server", "exit 0");
  stub("redis-cli", "exit 0");
  // Records its own environment on the side rather than in the shared
  // log, which other tests match line by line.
  const railsEnvFile = join(dir, "rails-env");
  stub("bin/rails", `printf '%s' "$RAILS_ENV" > "${railsEnvFile}"\nexit 0`);
  stub("bundle", `exit ${opts.suiteExit}`);
  // The two commands only the root branch reaches. `su` runs what it was
  // given, so the script's own `sh -c` body still executes either way -
  // which is the point: both branches have to really work.
  stub("id", `echo ${opts.uid ?? 1001}`);
  stub("chown", "exit 0");
  stub("su", `shift 4\nexec /bin/sh -c "$1"`);

  // This run's own /etc/passwd and /etc/group - see `userFiles`. An
  // unwritable pair is one inside a directory that does not exist, which
  // is unwritable to root as well: this test suite can and does run as
  // root in a container.
  const users = opts.passwdUnwritable === true ? join(dir, "no-such-dir") : dir;
  const passwd = join(users, "passwd");
  const group = join(users, "group");
  const uid = opts.uid ?? 1001;
  if (opts.passwdUnwritable !== true) {
    writeFileSync(
      passwd,
      opts.uidHasNoEntry === true ? `root:x:0:0:root:/root:/bin/sh\n` : `someone:x:${uid}:${uid}::/tmp:/bin/sh\n`
    );
    writeFileSync(group, opts.uidHasNoEntry === true ? `root:x:0:\n` : `someone:x:${uid}:\n`);
  }
  // The real `getent` would answer from this machine's own users, which
  // is exactly what no test here may depend on. This one answers from
  // the pair of files above, and from nothing else.
  stub(
    "getent",
    `case "$1" in\n` +
      `  passwd) fabrica_file="${passwd}" ;;\n` +
      `  group) fabrica_file="${group}" ;;\n` +
      `  *) exit 2 ;;\n` +
      `esac\n` +
      `[ -f "$fabrica_file" ] || exit 2\n` +
      `cut -d: -f3 "$fabrica_file" | grep -qx "$2"`
  );

  // The lines that have to be rewritten rather than stubbed, because
  // they name absolute paths belonging to the machine: the glob of
  // Debian's own /usr/lib/postgresql, which no test may write into, and
  // the two user files. Everything else - the guard, the quoting through
  // pg_as, the backgrounded start, the stop in the trap - runs exactly
  // as generated.
  const generated = userFiles(
    checkScript(opts.suite, railsShape(), opts.terms ?? "repository").replace(
      "PGBIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -n 1)",
      `PGBIN=${pgbin}`
    ),
    { passwd, group }
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
    passwd: existsSync(passwd) ? readFileSync(passwd, "utf8") : ``,
    group: existsSync(group) ? readFileSync(group, "utf8") : ``,
    railsEnv: existsSync(railsEnvFile) ? readFileSync(railsEnvFile, "utf8") : ``,
  };
}

/**
 * The generated script pointed at a throwaway `/etc/passwd` and
 * `/etc/group` instead of the machine's own.
 *
 * This is not a convenience. The script appends an entry to
 * `/etc/passwd` when the uid running it has none, which is right inside
 * Inspector's check box and catastrophic on a developer's machine or a
 * CI runner - and this suite does run as root in a container, where
 * nothing would stop it. So every path a test gives the script is a path
 * under that test's own temporary directory, with no option to use the
 * real one.
 */
function userFiles(script: string, paths: { passwd: string; group: string }): string {
  return script.replaceAll("/etc/passwd", paths.passwd).replaceAll("/etc/group", paths.group);
}

/** The order of the real steps, with the readiness polling and the
 * `id`/`getent`/`chown`/`su` bookkeeping filtered out: those are
 * asserted separately, by their own tests. */
function steps(log: string[]): string[] {
  return log.filter((line) => !/^(?:pgbin\/pg_isready|id|getent|chown|su)\b/.test(line));
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

// Read out of the environment `bin/rails` was really given, not off the
// script's text: a `RAILS_ENV=test` that was assigned and never exported
// reads identically in the file and reaches nothing.
test("the generated check.sh really hands RAILS_ENV=test to bin/rails", () => {
  const { status, railsEnv, log } = runGeneratedCheck({ suite: "bundle exec rspec", suiteExit: 0 });

  assert.equal(status, 0, log.join("\n"));
  assert.equal(railsEnv, "test", log.join("\n"));
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

// The guard as generated, with nothing stubbed - so the whole script
// runs, as a box with no PostgreSQL installed runs it.
//
// The one thing rewritten is the directory the guard globs, pointed at
// an empty one of this test's own. Not for tidiness: aimed at the real
// /usr/lib/postgresql this test passes or fails according to whether the
// machine running it happens to have PostgreSQL installed - and on a
// machine that does, the guard is satisfied and the script carries on to
// the next server, failing with whatever *that* box is missing instead
// (exit 127, "redis-server: not found", on the CI host). The message
// below still names the real path, because the generated script does.
test("the generated check.sh fails loudly, and early, in a box with no PostgreSQL in it", () => {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-checkscript-"));
  const empty = join(dir, "no-postgresql-here");
  mkdirSync(empty);
  writeFileSync(join(dir, "passwd"), `someone:x:${process.getuid?.() ?? 0}:0::/tmp:/bin/sh\n`);
  writeFileSync(join(dir, "group"), `someone:x:0:\n`);
  const script = userFiles(
    checkScript("bundle exec rspec", railsShape()).replace("ls -d /usr/lib/postgresql/*/bin", `ls -d ${empty}/*/bin`),
    { passwd: join(dir, "passwd"), group: join(dir, "group") }
  );
  writeFileSync(join(dir, "check.sh"), script);
  chmodSync(join(dir, "check.sh"), 0o755);
  const run = spawnSync("/bin/sh", [join(dir, "check.sh")], { encoding: "utf8", cwd: dir });

  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /no PostgreSQL server binaries under \/usr\/lib\/postgresql/);
  assert.match(run.stderr, /Dockerfile\.inspector/);
});

// Issue #337, the finding a real Inspector run turned up and no
// substring assertion could: initdb resolves its own effective uid to a
// user *name* before it does anything else, with no flag that skips it,
// and the check box's uid is in no /etc/passwd at all. The run died on
// "could not look up effective user ID 1001: user does not exist".
test("the generated check.sh gives the uid it runs as a passwd entry when it has none", () => {
  const { status, log, passwd, group, stderr } = runGeneratedCheck({
    suite: "bundle exec rspec",
    suiteExit: 0,
    uidHasNoEntry: true,
  });

  assert.equal(status, 0, stderr);
  // A real entry, with the uid and gid the box is running as - not a
  // name that happens to be in the file.
  assert.match(passwd, /^fabrica:x:1001:1001:[^:]*:\/tmp:\/bin\/sh$/m, passwd);
  assert.match(group, /^fabrica:x:1001:$/m, group);
  // And the cluster still got created, after it, in the same order as
  // any other box.
  const entry = log.findIndex((line) => line.startsWith("getent passwd"));
  const initdb = log.findIndex((line) => line.startsWith("pgbin/initdb"));
  assert.ok(entry >= 0 && entry < initdb, log.join("\n"));
});

// The other half: a box whose uid does resolve - a rootless Docker
// daemon's root, or anything run outside Inspector - is left exactly as
// it is. A second entry for a uid that has one is a worse file than the
// one it replaced.
test("the generated check.sh adds nothing when the uid already resolves", () => {
  const { status, passwd, group, stderr } = runGeneratedCheck({ suite: "bundle exec rspec", suiteExit: 0 });

  assert.equal(status, 0, stderr);
  assert.doesNotMatch(passwd, /fabrica/, passwd);
  assert.doesNotMatch(group, /fabrica/, group);
});

// The box that cannot be fixed from inside: Dockerfile.inspector's
// `chmod a+w` gone, so there is nowhere to write the entry. That has to
// say so, naming the line that is missing, rather than letting
// PostgreSQL fail later with a message about user IDs.
test("the generated check.sh refuses, naming the Dockerfile line, when it cannot write the entry", () => {
  const { status, stderr, log } = runGeneratedCheck({
    suite: "bundle exec rspec",
    suiteExit: 0,
    uidHasNoEntry: true,
    passwdUnwritable: true,
  });

  assert.equal(status, 1, stderr);
  assert.match(stderr, /uid 1001 has no .* entry/, stderr);
  assert.match(stderr, /Dockerfile\.inspector has to keep its 'RUN chmod a\+w /, stderr);
  // Before anything was started, which is the point of doing it here.
  assert.deepEqual(
    log.filter((line) => line.startsWith("pgbin/") || line.startsWith("redis-server")),
    [],
    log.join("\n")
  );
});

// The other half of removing the scratch directory: every server logs in
// there, so a failing check would otherwise report that PostgreSQL never
// came up and nothing at all about why - the one file saying why is
// removed by the same cleanup that makes the check tidy. Inspector's red
// report is the Client's whole view of a failed check, so what is not in
// the check's own output is not anywhere.
test("the generated check.sh puts a server's own log in the output when the check fails", () => {
  const { status, stderr } = runGeneratedCheck({
    suite: "bundle exec rspec",
    suiteExit: 0,
    initdbFails: true,
  });

  assert.notEqual(status, 0, stderr);
  // The log file's own contents, not merely its path: the path is inside
  // a directory that no longer exists by the time anyone reads this.
  assert.match(stderr, /initdb: could not create directory, Permission denied/, stderr);
  assert.match(stderr, /after a failing check/, stderr);
});

// The counterpart: a green check's output is read by people, and a
// server's startup chatter in it is noise.
test("the generated check.sh prints no server logs when the check passes", () => {
  const { status, stderr } = runGeneratedCheck({ suite: "bundle exec rspec", suiteExit: 0 });

  assert.equal(status, 0, stderr);
  assert.doesNotMatch(stderr, /after a failing check/, stderr);
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
  // Including the path where the cleanup reads the logs in there first,
  // which is the one that touches the directory before removing it.
  const { scratchDirs } = runGeneratedCheck({
    suite: "bundle exec rspec",
    suiteExit: 0,
    initdbFails: true,
  });
  assert.deepEqual(scratchDirs, before, "a scratch directory survived a failing initdb");
});
