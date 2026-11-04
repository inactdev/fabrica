// The Dockerfile.inspector register writes (issue #303).
//
// Everything here is a pure function over a FROM line and which
// lockfiles a repository carries, so none of it needs a repository - the
// one exception reads a real directory, and reads this repository's own
// Dockerfile.inspector as the reference shape, since that file is the
// only live evidence of a check image that actually builds.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEPS_DIR,
  DOCKERFILE_INSPECTOR,
  dependencyInstallerIn,
  dependencyShapeFrom,
  dependencyShapeInTree,
  gemfileReferences,
  gemsIn,
  inspectorDockerfile,
  knownNonRootUser,
} from "./dockerfile.ts";
import {
  RAILS_GEMFILE,
  RAILS_GEMFILE_LOCK,
  railsFixtureFiles,
  writeRailsFixture,
} from "./helpers/rails-fixture.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function lines(text: string): string[] {
  return text.split("\n");
}

/** The file's real instructions, with its comments and blanks dropped. */
function instructions(text: string): string[] {
  return lines(text)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

// --------------------------------------------------------- the shapes

test("dependencyShapeFrom: package-lock.json means npm ci, go.sum means go mod download", () => {
  assert.equal(dependencyShapeFrom({ packageLock: true, goSum: false })?.install, "npm ci");
  assert.equal(dependencyShapeFrom({ packageLock: false, goSum: true })?.install, "go mod download");
  assert.equal(dependencyShapeFrom({ packageLock: false, goSum: false }), null);
});

// Only a node_modules has to be linked into the checkout: a Go module
// cache lives in the image, outside it, where `go test` already looks.
test("dependencyShapeFrom: only the npm shape needs check.sh to link anything in", () => {
  assert.equal(dependencyShapeFrom({ packageLock: true, goSum: false })?.linksNodeModules, true);
  assert.equal(dependencyShapeFrom({ packageLock: false, goSum: true })?.linksNodeModules, false);
});

// ------------------------------------------------- the Ruby shape (#324)

// A Gemfile.lock's contents are read, not just its presence: only the
// lockfile can say whether the check box needs a database server in it.
test("gemsIn reads the gems in the bundle, never the requirement lines under them", () => {
  const gems = gemsIn(RAILS_GEMFILE_LOCK);

  assert.equal(gems.has("pg"), true);
  assert.equal(gems.has("redis"), true);
  assert.equal(gems.has("rspec-core"), true);
  // Six spaces deep, i.e. something capybara asked for, and never a
  // resolved gem of its own in this lockfile.
  assert.equal(gems.has("nokogiri"), false, "a requirement line says what was asked for, not what is installed");
  // Two spaces deep, under DEPENDENCIES - the Gemfile's own list.
  assert.equal(gems.has("DEPENDENCIES"), false);
});

test("dependencyShapeFrom: a Gemfile.lock means bundle install, and no node_modules to link", () => {
  const shape = dependencyShapeFrom({ packageLock: false, goSum: false, gemfileLock: RAILS_GEMFILE_LOCK });

  assert.equal(shape?.install, "bundle install");
  assert.equal(shape?.lockfile, "Gemfile.lock");
  assert.equal(shape?.manifest, "Gemfile");
  // Gems land in the image's own GEM_HOME, outside the checkout - like a
  // Go module cache, unlike node_modules.
  assert.equal(shape?.linksNodeModules, false);
});

// A Rails application with a JavaScript bundler carries both lockfiles,
// and its suite is still the Ruby one.
test("dependencyShapeFrom: Gemfile.lock wins over a package-lock.json beside it", () => {
  const shape = dependencyShapeFrom({ packageLock: true, goSum: true, gemfileLock: RAILS_GEMFILE_LOCK });

  assert.equal(shape?.install, "bundle install");
});

test("dependencyShapeFrom: the servers come from the lockfile, never from the shape being Ruby", () => {
  const labels = (lockfile: string) =>
    (dependencyShapeFrom({ packageLock: false, goSum: false, gemfileLock: lockfile })?.services ?? []).map(
      (service) => service.label
    );

  assert.deepEqual(labels(RAILS_GEMFILE_LOCK), ["PostgreSQL", "Redis"]);
  assert.deepEqual(labels("GEM\n  specs:\n    pg (1.5.6)\n"), ["PostgreSQL"]);
  // redis-client is what a current Rails cache store or Sidekiq
  // resolves to, and names a Redis dependency just as surely.
  assert.deepEqual(labels("GEM\n  specs:\n    redis-client (0.22.2)\n"), ["Redis"]);
  assert.deepEqual(labels("GEM\n  specs:\n    rake (13.2.1)\n"), [], "a plain Ruby project needs no server");
});

// `bin/rails db:test:prepare` is only a command a repository shipping
// bin/rails actually has.
test("dependencyShapeFrom: the test-database step needs bin/rails, not just a Gemfile.lock", () => {
  const withRails = dependencyShapeFrom({
    packageLock: false,
    goSum: false,
    gemfileLock: RAILS_GEMFILE_LOCK,
    railsBin: true,
  });
  const without = dependencyShapeFrom({ packageLock: false, goSum: false, gemfileLock: RAILS_GEMFILE_LOCK });

  assert.equal(withRails?.prepare?.run, "bin/rails db:test:prepare");
  assert.equal(without?.prepare, undefined);
});

// A Gemfile may read its own `ruby` line out of .ruby-version, so the
// file is copied in when it is there - and never when it is not, since a
// COPY of a file the repository lacks fails the build.
test("dependencyShapeFrom: .ruby-version is copied in only when the repository has one", () => {
  const present = dependencyShapeFrom({
    packageLock: false,
    goSum: false,
    gemfileLock: RAILS_GEMFILE_LOCK,
    rubyVersionFile: true,
  });
  const absent = dependencyShapeFrom({ packageLock: false, goSum: false, gemfileLock: RAILS_GEMFILE_LOCK });

  assert.deepEqual(present?.extraCopies, [".ruby-version"]);
  assert.equal(absent?.extraCopies, undefined);
});

test("inspectorDockerfile: the Ruby shape installs its servers and its gems at build time", () => {
  const text = inspectorDockerfile({
    from: "ruby:3.3.4",
    reason: "--image said so",
    shape: dependencyShapeFrom({
      packageLock: false,
      goSum: false,
      gemfileLock: RAILS_GEMFILE_LOCK,
      rubyVersionFile: true,
      railsBin: true,
    }),
  });
  const ran = instructions(text);

  assert.ok(ran.includes("FROM ruby:3.3.4"), text);
  assert.ok(ran.includes("USER root"), "apt-get needs root");
  assert.ok(
    ran.some((line) => line.includes("apt-get install") && line.includes("postgresql libpq-dev redis-server")),
    text
  );
  // The pg gem's native extension wants libpq-fe.h, which libpq-dev is
  // what installs.
  assert.ok(text.includes("libpq-dev"), text);
  assert.ok(ran.includes(`COPY Gemfile Gemfile.lock .ruby-version ${DEPS_DIR}/`), text);
  assert.ok(ran.includes(`RUN cd ${DEPS_DIR} && bundle install`), text);
});

// Issue #337. The packages, and nothing else: Inspector runs the check
// as the uid of whoever invoked it, which has no /etc/passwd entry and
// is not the user this image is built as - so a cluster created here,
// or a role created for the build user, is unusable at check time.
// PostgreSQL in particular refuses a data directory it does not own.
// What this replaced read as working right up until a real Inspector
// ran it.
test("inspectorDockerfile: the servers are installed and nothing about them is set up at build time", () => {
  const text = inspectorDockerfile({
    from: "ruby:3.3.4",
    reason: "--image said so",
    shape: dependencyShapeFrom({
      packageLock: false,
      goSum: false,
      gemfileLock: RAILS_GEMFILE_LOCK,
      railsBin: true,
    }),
  });
  const ran = instructions(text);

  assert.ok(
    ran.some((line) => line.includes("apt-get install") && line.includes("postgresql")),
    text
  );
  for (const line of ran) {
    // `apt-get install ... redis-server` is the package, not a server
    // being started, so the starting forms are what is named here.
    if (line.includes("apt-get")) continue;
    assert.doesNotMatch(line, /createuser/, `${line} creates a role for a user the check will not be`);
    assert.doesNotMatch(line, /initdb|pg_createcluster/, `${line} creates a cluster the check cannot own`);
    assert.doesNotMatch(
      line,
      /service postgresql|redis-server --|pg_ctl/,
      `${line} starts a server at build time`
    );
  }
  // And the file says why, so the next person to read it does not add
  // one of those back.
  assert.ok(text.includes("/etc/passwd"), text);
});

// The one thing the image can do about that uid, as opposed to saying it
// cannot: leave the two files writable, so check.sh can add an entry for
// whoever it turns out to be running as. initdb resolves its own
// effective uid to a user name before it does anything else, and no flag
// skips it - without an entry there is no cluster to create at all.
test("inspectorDockerfile: a server that looks the user up gets a writable passwd file", () => {
  const withPostgres = inspectorDockerfile({
    from: "ruby:3.3.4",
    reason: "--image said so",
    shape: dependencyShapeFrom({ packageLock: false, goSum: false, gemfileLock: RAILS_GEMFILE_LOCK, railsBin: true }),
  });
  // Redis alone needs nothing of the sort - it drops no privileges and
  // looks nothing up - so the image it gets is left alone.
  const redisOnly = inspectorDockerfile({
    from: "ruby:3.3.4",
    reason: "--image said so",
    shape: dependencyShapeFrom({
      packageLock: false,
      goSum: false,
      gemfileLock: "GEM\n  specs:\n    redis (5.0.0)\n",
    }),
  });

  assert.ok(instructions(withPostgres).includes("RUN chmod a+w /etc/passwd /etc/group"), withPostgres);
  // Under the USER root that the package install already needed, since
  // nothing else in the image could do it.
  assert.ok(
    instructions(withPostgres).indexOf("USER root") <
      instructions(withPostgres).indexOf("RUN chmod a+w /etc/passwd /etc/group"),
    withPostgres
  );
  assert.doesNotMatch(redisOnly, /chmod a\+w/, redisOnly);
});

// Issue #337's third finding: with terms in a folder outside the
// repository, Inspector resolves the docker build context against that
// folder, which holds no Gemfile at all. The repository is reachable
// only as the named build context Inspector supplies it as.
test("inspectorDockerfile: a terms folder's install step copies from the named repo context", () => {
  const shape = dependencyShapeFrom({
    packageLock: false,
    goSum: false,
    gemfileLock: RAILS_GEMFILE_LOCK,
    rubyVersionFile: true,
  });
  const text = inspectorDockerfile({
    from: "ruby:3.3.4",
    reason: "--image said so",
    shape,
    repoFiles: "named-repo-context",
  });

  assert.ok(
    instructions(text).includes(`COPY --from=repo Gemfile Gemfile.lock .ruby-version ${DEPS_DIR}/`),
    text
  );
  // ...and says what `repo` is, since there is no multi-stage build
  // anywhere in the file for a reader to tie it to.
  assert.ok(text.includes("named build context"), text);

  // The repository route is unchanged - it must not grow a dependency
  // on inspector#81 it has no need for, since its own build context
  // genuinely is the repository.
  const inRepo = inspectorDockerfile({ from: "ruby:3.3.4", reason: "--image said so", shape });
  assert.ok(instructions(inRepo).includes(`COPY Gemfile Gemfile.lock .ruby-version ${DEPS_DIR}/`), inRepo);
  assert.doesNotMatch(inRepo, /--from=repo/, inRepo);
});

// ------------------------- what the Gemfile names inside the repository
//
// Issue #337's fix round. Found on the Client's own work repository:
// its Gemfile names a gem kept in the repository (`path:
// "engines/prototypes"`), and `bundle install` stopped on
// "/deps/engines/prototypes does not exist" before installing anything.
// A relative path in a Gemfile resolves against the directory holding
// the Gemfile, which during this build is /deps - so the path has to be
// reproduced under /deps, not flattened in beside the manifest.

test("gemfileReferences: the three directives that name a path in the repository", () => {
  const found = gemfileReferences(
    `source "https://rubygems.org"\n` +
      `gem "rails"\n` +
      `gem "prototypes", path: "engines/prototypes"\n` +
      `gem "legacy", :path => "vendor/legacy"\n` +
      `eval_gemfile "gemfiles/extra.rb"\n`
  );

  assert.deepEqual(found, [
    { directive: "path", source: "engines/prototypes", dest: `${DEPS_DIR}/engines/prototypes/` },
    { directive: "path", source: "vendor/legacy", dest: `${DEPS_DIR}/vendor/legacy/` },
    // The file itself, so the destination is the directory holding it -
    // a COPY of a file into a path with no trailing slash would write
    // the file *as* that path.
    { directive: "eval_gemfile", source: "gemfiles/extra.rb", dest: `${DEPS_DIR}/gemfiles/` },
  ]);
});

// A bare `gemspec` reads a *.gemspec beside the Gemfile, which the
// manifest's own COPY does not bring. A `gemspec path:` names a
// directory instead, and the generic path: rule above already copies it
// with its gemspec inside - so it must not also ask for a *.gemspec at
// the root that is not there, which would fail the build.
test("gemfileReferences: a bare gemspec wants the one beside the Gemfile, a gemspec path: does not", () => {
  assert.deepEqual(gemfileReferences(`gemspec\n`), [
    { directive: "gemspec", source: "*.gemspec", dest: `${DEPS_DIR}/` },
  ]);
  assert.deepEqual(gemfileReferences(`gemspec path: "engines/thing"\n`), [
    { directive: "path", source: "engines/thing", dest: `${DEPS_DIR}/engines/thing/` },
  ]);
});

test("gemfileReferences: a commented-out directive is not one, and the same path is copied once", () => {
  assert.deepEqual(gemfileReferences(`# gem "old", path: "engines/old"\ngem "x" # path: "engines/x"\n`), []);
  // A `#` inside a quoted string is part of it, not the start of a
  // comment - so the path before one is still read.
  assert.deepEqual(gemfileReferences(`gem "x", path: "engines/a" # a gem we keep\n`), [
    { directive: "path", source: "engines/a", dest: `${DEPS_DIR}/engines/a/` },
  ]);
  // Two gems in one directory are one COPY.
  assert.deepEqual(gemfileReferences(`gem "x", path: "engines/a"\ngem "y", path: "engines/a"\n`), [
    { directive: "path", source: "engines/a", dest: `${DEPS_DIR}/engines/a/` },
  ]);
});

test("dependencyShapeFrom: pathCopies comes from the Gemfile, and is absent when there is nothing to copy", () => {
  const withPath = dependencyShapeFrom({
    packageLock: false,
    goSum: false,
    gemfileLock: RAILS_GEMFILE_LOCK,
    gemfile: `gem "prototypes", path: "engines/prototypes"\n`,
  });
  const without = dependencyShapeFrom({
    packageLock: false,
    goSum: false,
    gemfileLock: RAILS_GEMFILE_LOCK,
    gemfile: RAILS_GEMFILE,
  });

  assert.deepEqual(withPath?.pathCopies?.map((reference) => reference.source), ["engines/prototypes"]);
  assert.equal(without?.pathCopies, undefined);
  // And a shape derived with no Gemfile read at all asks for nothing,
  // rather than guessing at what a manifest it never saw might name.
  assert.equal(
    dependencyShapeFrom({ packageLock: false, goSum: false, gemfileLock: RAILS_GEMFILE_LOCK })?.pathCopies,
    undefined
  );
});

test("inspectorDockerfile: each path the Gemfile names is copied to its own path, before the install", () => {
  const shape = dependencyShapeFrom({
    packageLock: false,
    goSum: false,
    gemfileLock: RAILS_GEMFILE_LOCK,
    gemfile: `gem "prototypes", path: "engines/prototypes"\ngem "legacy", path: "vendor/legacy"\n`,
  });
  const text = inspectorDockerfile({
    from: "ruby:3.3.4",
    reason: "--image said so",
    shape,
    repoFiles: "named-repo-context",
  });
  const ran = instructions(text);

  // One COPY each, not one COPY with two sources: several sources go
  // into one destination directory, which would flatten both gems into
  // the same place under a name bundler is not looking for.
  assert.ok(ran.includes(`COPY --from=repo engines/prototypes ${DEPS_DIR}/engines/prototypes/`), text);
  assert.ok(ran.includes(`COPY --from=repo vendor/legacy ${DEPS_DIR}/vendor/legacy/`), text);
  // Before the install, which is the step that reads them.
  assert.ok(
    ran.indexOf(`COPY --from=repo engines/prototypes ${DEPS_DIR}/engines/prototypes/`) <
      ran.indexOf(`RUN cd ${DEPS_DIR} && bundle install`),
    text
  );
  // ...and after the manifest's own COPY, so a reader sees what named
  // them before what they are.
  assert.ok(
    ran.indexOf(`COPY --from=repo Gemfile Gemfile.lock ${DEPS_DIR}/`) <
      ran.indexOf(`COPY --from=repo engines/prototypes ${DEPS_DIR}/engines/prototypes/`),
    text
  );
});

// The repository route needs the same copies: the path is relative to
// the Gemfile either way, and /deps is the Gemfile's directory in both
// builds. Only the `--from=repo` differs.
test("inspectorDockerfile: the in-repository route copies the same paths, from its own context", () => {
  const text = inspectorDockerfile({
    from: "ruby:3.3.4",
    reason: "--image said so",
    shape: dependencyShapeFrom({
      packageLock: false,
      goSum: false,
      gemfileLock: RAILS_GEMFILE_LOCK,
      gemfile: `gem "prototypes", path: "engines/prototypes"\n`,
    }),
  });

  assert.ok(instructions(text).includes(`COPY engines/prototypes ${DEPS_DIR}/engines/prototypes/`), text);
  assert.doesNotMatch(text, /--from=repo/, text);
});

// A path a build context cannot reach: Docker strips `../` navigation
// from a COPY source silently, and an absolute source is not a context
// path at all. Saying so in the file is the loud answer; emitting a COPY
// Docker then rewrites is the quiet one.
test("inspectorDockerfile: a path outside the repository is named in a comment, never copied", () => {
  const text = inspectorDockerfile({
    from: "ruby:3.3.4",
    reason: "--image said so",
    shape: dependencyShapeFrom({
      packageLock: false,
      goSum: false,
      gemfileLock: RAILS_GEMFILE_LOCK,
      gemfile: `gem "outside", path: "../sibling"\ngem "rooted", path: "/opt/gem"\n`,
    }),
  });

  assert.doesNotMatch(text, /COPY \.\.\/sibling/, text);
  assert.doesNotMatch(text, /COPY \/opt\/gem/, text);
  assert.ok(text.includes(`Not copied`), text);
  assert.ok(text.includes(`"../sibling"`), text);
  assert.ok(text.includes(`"/opt/gem"`), text);
});

test("dependencyShapeInTree reads the Gemfile for the paths it names, not just the lockfile", () => {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-dockerfile-path-gem-"));
  writeRailsFixture(dir, {
    ...railsFixtureFiles(),
    Gemfile: `${RAILS_GEMFILE}gem "prototypes", path: "engines/prototypes"\n`,
  });

  assert.deepEqual(
    dependencyShapeInTree(dir)?.pathCopies?.map((reference) => reference.dest),
    [`${DEPS_DIR}/engines/prototypes/`]
  );
});

// Nothing in a Dockerfile can start a server for the check: a RUN is its
// own container, gone by the next line. check.sh starts them.
test("inspectorDockerfile: nothing in it leaves a server running", () => {
  const text = inspectorDockerfile({
    from: "ruby:3.3.4",
    reason: "--image said so",
    shape: dependencyShapeFrom({ packageLock: false, goSum: false, gemfileLock: RAILS_GEMFILE_LOCK }),
  });

  assert.ok(!instructions(text).some((line) => line.startsWith("CMD") || line.startsWith("ENTRYPOINT")), text);
});

test("inspectorDockerfile: the Ruby install step names the files bundler does not get", () => {
  const text = inspectorDockerfile({
    from: "ruby:3.3.4",
    reason: "--image said so",
    shape: dependencyShapeFrom({ packageLock: false, goSum: false, gemfileLock: RAILS_GEMFILE_LOCK }),
  });

  assert.ok(text.includes("gemspec"), text);
  assert.ok(text.includes(".bundle/config"), text);
});

test("dependencyShapeInTree reads the lockfiles a real checkout carries", () => {
  const empty = mkdtempSync(join(tmpdir(), "fabrica-dockerfile-"));
  assert.equal(dependencyShapeInTree(empty), null);

  const node = mkdtempSync(join(tmpdir(), "fabrica-dockerfile-node-"));
  writeFileSync(join(node, "package-lock.json"), "{}\n");
  assert.equal(dependencyShapeInTree(node)?.lockfile, "package-lock.json");

  const go = mkdtempSync(join(tmpdir(), "fabrica-dockerfile-go-"));
  writeFileSync(join(go, "go.sum"), "example.com/x v1.0.0 h1:abc=\n");
  assert.equal(dependencyShapeInTree(go)?.lockfile, "go.sum");

  // The Ruby shape reads four things off a real checkout, not one.
  const rails = mkdtempSync(join(tmpdir(), "fabrica-dockerfile-rails-"));
  writeRailsFixture(rails);
  const shape = dependencyShapeInTree(rails);
  assert.equal(shape?.lockfile, "Gemfile.lock");
  assert.deepEqual(shape?.extraCopies, [".ruby-version"]);
  assert.equal(shape?.prepare?.run, "bin/rails db:test:prepare");
  assert.deepEqual((shape?.services ?? []).map((service) => service.label), ["PostgreSQL", "Redis"]);
});

// --------------------------------------------------------- the FROM line

test("inspectorDockerfile puts the image on FROM, with where it came from as a comment", () => {
  const text = inspectorDockerfile({
    from: "cimg/node:24.18.0",
    reason: "package.json's engines.node pins node 24.18.0 exactly",
    shape: null,
  });

  assert.ok(instructions(text).includes("FROM cimg/node:24.18.0"), text);
  // JSON had nowhere to put the reasoning; a Dockerfile does.
  assert.ok(text.includes("engines.node pins node 24.18.0"), text);
  assert.ok(text.endsWith("\n"), "a file a human edits later ends in a newline");
});

test("inspectorDockerfile says what the file is for and who wrote it", () => {
  const text = inspectorDockerfile({ from: "node:24.18.0", reason: "--image said so", shape: null });

  assert.ok(text.includes("fabrica register"), text);
  assert.ok(text.includes("no network"), text);
});

// ------------------------------------------------------- the install step

test("inspectorDockerfile: a package-lock.json project installs it at build time, into /deps", () => {
  const text = inspectorDockerfile({
    from: "node:24.18.0",
    reason: "--image said so",
    shape: dependencyShapeFrom({ packageLock: true, goSum: false }),
  });

  assert.ok(instructions(text).includes(`COPY package.json package-lock.json ${DEPS_DIR}/`), text);
  assert.ok(instructions(text).includes(`RUN cd ${DEPS_DIR} && npm ci`), text);
});

test("inspectorDockerfile: a go.sum project fills the module cache at build time", () => {
  const text = inspectorDockerfile({
    from: "golang:1.22",
    reason: "--image said so",
    shape: dependencyShapeFrom({ packageLock: false, goSum: true }),
  });

  assert.ok(instructions(text).includes(`COPY go.mod go.sum ${DEPS_DIR}/`), text);
  assert.ok(instructions(text).includes(`RUN cd ${DEPS_DIR} && go mod download`), text);
});

// `npm ci` runs the project's own `prepare`/`postinstall` scripts, and
// only the two files copied above it are there when it does - this
// repository's own Dockerfile.inspector copies a third for exactly that
// reason. Named in the file rather than left to a failed build.
test("inspectorDockerfile: the npm install step names its lifecycle-script caveat", () => {
  const text = inspectorDockerfile({
    from: "node:24.18.0",
    reason: "--image said so",
    shape: dependencyShapeFrom({ packageLock: true, goSum: false }),
  });

  assert.ok(text.includes("lifecycle scripts"), text);
  assert.ok(text.includes("postinstall"), text);
  // Still a comment, never an invented COPY of a file nothing named.
  assert.deepEqual(
    instructions(text).filter((line) => line.startsWith("COPY")),
    [`COPY package.json package-lock.json ${DEPS_DIR}/`]
  );
});

test("inspectorDockerfile: the go install step has no lifecycle-script caveat to make", () => {
  const text = inspectorDockerfile({
    from: "golang:1.22",
    reason: "--image said so",
    shape: dependencyShapeFrom({ packageLock: false, goSum: true }),
  });

  assert.ok(!text.includes("lifecycle scripts"), text);
});

// "A shape it does not recognize gets a comment in the Dockerfile naming
// what still has to be installed there, never a silent gap" - issue #303.
test("inspectorDockerfile: an unrecognized shape gets a comment, never a silent gap", () => {
  const text = inspectorDockerfile({ from: "python:3.12", reason: "--image said so", shape: null });

  assert.deepEqual(instructions(text), ["FROM python:3.12"], "no install step is invented");
  assert.ok(text.includes("package-lock.json"), text);
  assert.ok(text.includes("go.sum"), text);
  assert.ok(text.includes("Add what ./check.sh needs here"), text);
});

// ------------------------------------------------- the image's own user

// One entry, and live evidence for it: this repository's own check image
// is a cimg/node, which runs as "circleci" and so cannot write a
// root-owned /deps. A user name is never guessed for anything else.
test("knownNonRootUser: cimg images run as circleci, everything else is assumed root", () => {
  assert.equal(knownNonRootUser("cimg/node:24.18.0"), "circleci");
  assert.equal(knownNonRootUser("cimg/base:2025.10"), "circleci");
  assert.equal(knownNonRootUser("node:24.18.0"), null);
  assert.equal(knownNonRootUser("golang:1.22"), null);
});

test("inspectorDockerfile: a cimg image is handed /deps before installing into it", () => {
  const text = inspectorDockerfile({
    from: "cimg/node:24.18.0",
    reason: "--image said so",
    shape: dependencyShapeFrom({ packageLock: true, goSum: false }),
  });

  assert.deepEqual(instructions(text), [
    "FROM cimg/node:24.18.0",
    "USER root",
    `RUN mkdir -p ${DEPS_DIR} && chown -R circleci:circleci ${DEPS_DIR}`,
    "USER circleci",
    `COPY --chown=circleci:circleci package.json package-lock.json ${DEPS_DIR}/`,
    `RUN cd ${DEPS_DIR} && npm ci`,
  ]);
});

// The gap that is left: an image running as a user this does not know
// about cannot write /deps either. It is named in the file rather than
// guessed at, since inventing a user name would fail the build with a
// confusing error instead of a legible instruction.
test("inspectorDockerfile: an unknown image's user gap is spelled out, not guessed", () => {
  const text = inspectorDockerfile({
    from: "node:24.18.0",
    reason: "--image said so",
    shape: dependencyShapeFrom({ packageLock: true, goSum: false }),
  });

  // Phrases short enough to survive the comment wrapper's line breaks.
  assert.ok(text.includes("default user"), text);
  assert.ok(text.includes("chown -R <user>:<user>"), text);
  assert.ok(text.includes("USER <user>"), text);
  assert.ok(!instructions(text).includes("USER root"), "no USER line is written for an unknown image");
});

// This repository's own Dockerfile.inspector (PR #302) is the reference,
// and the generated file has to agree with it on the mechanism: same
// FROM, same /deps, same npm ci, same ownership dance.
test("the generated node shape matches this repository's own Dockerfile.inspector", () => {
  const ours = readFileSync(join(repoRoot, DOCKERFILE_INSPECTOR), "utf8");
  const from = /^FROM\s+(\S+)/m.exec(ours)?.[1];
  assert.ok(from !== undefined, ours);

  const generated = instructions(
    inspectorDockerfile({
      from,
      reason: "--image said so",
      shape: dependencyShapeFrom({ packageLock: true, goSum: false }),
    })
  );

  for (const line of generated) {
    assert.ok(
      instructions(ours).some((theirs) => theirs.startsWith(line.split(" /deps")[0])),
      `${line} has no counterpart in this repository's own ${DOCKERFILE_INSPECTOR}:\n${ours}`
    );
  }
  assert.ok(ours.includes(`${DEPS_DIR}`), "and it is still /deps on both sides");
});

// ------------------------------------------------------- the one warning

test("dependencyInstallerIn names the fetching command as the text spells it", () => {
  assert.equal(dependencyInstallerIn("npm ci && npm test"), "npm ci");
  assert.equal(dependencyInstallerIn("npm i\nnpm test"), "npm i");
  assert.equal(dependencyInstallerIn("pip3  install -r requirements.txt"), "pip3 install");
  assert.equal(dependencyInstallerIn("go mod tidy && go test ./..."), "go mod tidy");
  assert.equal(dependencyInstallerIn("npm test"), null);
});
