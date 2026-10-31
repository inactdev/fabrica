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
  gemsIn,
  inspectorDockerfile,
  knownNonRootUser,
} from "./dockerfile.ts";
import { RAILS_GEMFILE_LOCK, writeRailsFixture } from "./helpers/rails-fixture.ts";

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
  // A role for the user the check runs as, created while the server is
  // up at build time: Rails' own database.yml names no user, so a local
  // socket connection is authenticated as whoever runs the check.
  assert.ok(
    ran.some((line) => line.includes(`su postgres -c "createuser -s root"`)),
    text
  );
  assert.ok(ran.includes(`COPY Gemfile Gemfile.lock .ruby-version ${DEPS_DIR}/`), text);
  assert.ok(ran.includes(`RUN cd ${DEPS_DIR} && bundle install`), text);
});

// Nothing in a Dockerfile can start a server for the check: a RUN is its
// own container, gone by the next line. check.sh starts them.
test("inspectorDockerfile: nothing in it leaves a server running", () => {
  const text = inspectorDockerfile({
    from: "ruby:3.3.4",
    reason: "--image said so",
    shape: dependencyShapeFrom({ packageLock: false, goSum: false, gemfileLock: RAILS_GEMFILE_LOCK }),
  });

  for (const line of instructions(text)) {
    if (!line.includes("postgresql start")) continue;
    assert.ok(line.includes("postgresql stop"), `${line} starts the server and never stops it`);
  }
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
