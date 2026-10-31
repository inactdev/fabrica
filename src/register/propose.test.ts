// The proposed `.inspector.json` (issue #114).
//
// Deriving is a pure function over three strings, so almost everything
// here needs no repository at all - the one test that does uses real git
// against a throwaway fixture, to prove the signals are read from a
// *commit* rather than from whatever is in the working tree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import {
  GO_MOD,
  IMAGE_PLACEHOLDER_PREFIX,
  PACKAGE_JSON,
  deriveProposal,
  proposeInspectorConfig,
  readProposalSignals,
  type ProposalSignals,
} from "./propose.ts";
import { GO_SUM } from "./dockerfile.ts";
import {
  RAILS_GEMFILE,
  RAILS_GEMFILE_LOCK,
  RAILS_RUBY_VERSION,
  railsFixtureFiles,
  writeRailsFixture,
} from "./helpers/rails-fixture.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const NOTHING: ProposalSignals = {
  checkScript: null,
  packageJson: null,
  goMod: null,
  packageLock: false,
  goSum: false,
  gemfileLock: null,
  gemfile: null,
  rubyVersion: null,
  railsBin: false,
};

/** Issue #324's shape, as the fixture Rails-shaped repository says it:
 * a Gemfile.lock naming pg, redis and rspec, a Gemfile, an exact
 * .ruby-version, and a bin/rails. */
const RAILS: Partial<ProposalSignals> = {
  gemfileLock: RAILS_GEMFILE_LOCK,
  gemfile: RAILS_GEMFILE,
  rubyVersion: RAILS_RUBY_VERSION,
  railsBin: true,
};

function propose(signals: Partial<ProposalSignals>) {
  const proposal = proposeInspectorConfig(
    { ...NOTHING, ...signals },
    { projectPath: "/srv/spending-app", defaultBranch: "main" }
  );
  return {
    ...proposal,
    config: JSON.parse(proposal.json) as Record<string, unknown>,
    stderr: proposal.notes.join("\n"),
  };
}

function pkg(contents: Record<string, unknown>): string {
  return JSON.stringify(contents, null, 2);
}

// ------------------------------------------------------------- check

test("propose: an existing check.sh wins, and the check is that file", () => {
  const { config, stderr } = propose({
    checkScript: "#!/bin/sh\nset -e\nnpm run lint && npm test\n",
    packageJson: pkg({ scripts: { test: "node --test" } }),
  });

  assert.equal(config.check, "./check.sh");
  assert.ok(stderr.includes("check: ./check.sh"), stderr);
  assert.ok(stderr.includes("wins over every other signal"), stderr);
  // The script's own commands are quoted back, without the shebang or
  // the `set -e` wrapper that carry none.
  assert.ok(stderr.includes("npm run lint && npm test"), stderr);
  assert.ok(!stderr.includes("#!/bin/sh"), stderr);
});

test("propose: with no check.sh, package.json's test script is the check", () => {
  const { config, stderr } = propose({ packageJson: pkg({ scripts: { test: "vitest run" } }) });

  assert.equal(config.check, "npm test");
  assert.ok(stderr.includes("check: npm test"), stderr);
  assert.ok(stderr.includes("vitest run"), stderr);
});

test("propose: a Go module with no check.sh gets the toolchain's own test command", () => {
  const { config, stderr } = propose({ goMod: "module example.com/app\n\ngo 1.22\n" });

  assert.equal(config.check, "go test ./...");
  assert.ok(stderr.includes("go 1.22"), stderr);
});

test("propose: a repository that names no command at all is told to write check.sh", () => {
  const { config, stderr } = propose({});

  assert.equal(config.check, "./check.sh");
  assert.ok(stderr.includes("nothing in the repository names a command"), stderr);
  assert.ok(stderr.includes("Write check.sh"), stderr);
});

// The printed proposal quotes the command and stops; a route that
// *writes* a check.sh (--terms, see terms.ts) has to know which of the
// three cases produced it, because they want different files. A `check`
// of "./check.sh" is two of them - the repository's own script, and
// nothing naming a command at all - which is exactly why the command
// alone is not enough to decide from.
test("deriveProposal: the check carries where it came from, not only what it is", () => {
  const source = (signals: Partial<ProposalSignals>) =>
    deriveProposal({ ...NOTHING, ...signals }).check.source;

  assert.equal(source({ checkScript: "#!/bin/sh\nnpm test\n" }), "repository-script");
  assert.equal(source({ packageJson: pkg({ scripts: { test: "node --test" } }) }), "declared-command");
  assert.equal(source({ goMod: "module example.com/app\n\ngo 1.22\n" }), "declared-command");
  assert.equal(source({}), "none");
});

// One derivation, two routes. Whatever `deriveProposal` says is what
// both the printed proposal and the written terms folder are built from,
// so a work-mode project can never be set up by a second set of rules.
test("deriveProposal: the printed proposal is built from exactly what it returns", () => {
  const signals = { ...NOTHING, packageJson: pkg({ engines: { node: "24.18.0" } }) };
  const derived = deriveProposal(signals);
  const proposal = proposeInspectorConfig(signals, { projectPath: "/srv/app", defaultBranch: "main" });

  assert.equal(proposal.dockerfile, derived.dockerfile);
  for (const line of derived.fieldNotes) {
    assert.ok(proposal.notes.includes(line), line);
  }
});

// "When signals disagree an existing check.sh wins and the disagreement
// is named on stderr" (Client ruling, issue #114's clarification).
test("propose: a check.sh that doesn't run package.json's test script names the disagreement", () => {
  const { config, stderr } = propose({
    checkScript: "#!/bin/sh\nset -e\n./scripts/ci.sh\n",
    packageJson: pkg({ scripts: { test: "node --test" } }),
  });

  assert.equal(config.check, "./check.sh", "check.sh still wins");
  assert.ok(stderr.includes("disagreement:"), stderr);
  assert.ok(stderr.includes("node --test"), stderr);
  assert.ok(stderr.includes("check.sh wins"), stderr);
});

test("propose: a check.sh that does run the test script is no disagreement", () => {
  for (const body of ["npm test\n", "npm run test\n", "node --test\n"]) {
    const { stderr } = propose({
      checkScript: `#!/bin/sh\nset -e\n${body}`,
      packageJson: pkg({ scripts: { test: "node --test" } }),
    });
    assert.ok(!stderr.includes("disagreement:"), `${body}: ${stderr}`);
  }
});

test("propose: a Go module whose check.sh runs no go test names that disagreement too", () => {
  const { stderr } = propose({
    checkScript: "#!/bin/sh\nmake verify\n",
    goMod: "module example.com/app\n\ngo 1.22\n",
  });

  assert.ok(stderr.includes("disagreement:"), stderr);
  assert.ok(stderr.includes(GO_MOD), stderr);
});

// ------------------------------------------ Dockerfile.inspector: FROM

// Since inspector#47 the image is a FROM line in a file, not a key in
// the config: the check box is built from Dockerfile.inspector.
test("propose: an exactly pinned engines.node derives the FROM image from it", () => {
  const { dockerfile, stderr } = propose({ packageJson: pkg({ engines: { node: "24.18.0" } }) });

  assert.ok(dockerfile.includes("FROM cimg/node:24.18.0"), dockerfile);
  assert.ok(stderr.includes("Dockerfile.inspector FROM: cimg/node:24.18.0"), stderr);
  assert.ok(stderr.includes("engines.node pins node 24.18.0"), stderr);
});

test("propose: a version range names no single tag, so the FROM image is a loud placeholder", () => {
  const { dockerfile, stderr } = propose({ packageJson: pkg({ engines: { node: ">=22" } }) });

  assert.ok(dockerfile.includes(`FROM ${IMAGE_PLACEHOLDER_PREFIX}`), dockerfile);
  assert.ok(stderr.includes(">=22"), stderr);
});

test("propose: a Go module's toolchain version is named, but no Go image is invented", () => {
  const { dockerfile, stderr } = propose({ goMod: "module example.com/app\n\ngo 1.22\n" });

  assert.ok(dockerfile.includes(`FROM ${IMAGE_PLACEHOLDER_PREFIX}an-image-that-ships-go-1.22`), dockerfile);
  assert.ok(stderr.includes("no verified Go image to offer"), stderr);
});

test("propose: with no signal at all the FROM image is a placeholder naming what it is for", () => {
  const { dockerfile, stderr } = propose({});

  assert.ok(dockerfile.includes(`FROM ${IMAGE_PLACEHOLDER_PREFIX}`), dockerfile);
  assert.ok(stderr.includes("already ships the toolchain the check needs"), stderr);
});

// A placeholder must fail loudly rather than resolve to something
// plausible: a Docker repository name has to be lowercase, so every
// placeholder this module can produce is an invalid reference.
test("propose: every image placeholder is an invalid Docker reference, never a plausible one", () => {
  const cases: Partial<ProposalSignals>[] = [
    {},
    { packageJson: pkg({ engines: { node: "^24.1.0" } }) },
    { goMod: "module example.com/app\n\ngo 1.23.1\n" },
  ];
  for (const signals of cases) {
    const image = /^FROM\s+(\S+)/m.exec(propose(signals).dockerfile)?.[1] ?? "";
    assert.notEqual(image, image.toLowerCase(), `${image} should carry uppercase, which Docker rejects`);
    assert.ok(!image.includes(":"), `${image} should not look like a name:tag pair`);
  }
});

// The config itself names no image and no network, with any value -
// inspector#47 retired both keys, and a proposal that still wrote one
// would be refused on the project's first task.
test("propose: the proposed config carries no image and no network key", () => {
  for (const signals of [
    {},
    { packageJson: pkg({ engines: { node: "24.18.0" } }), packageLock: true },
    { checkScript: "#!/bin/sh\nnpm ci && npm test\n" },
  ]) {
    const { config } = propose(signals);
    assert.equal(Object.hasOwn(config, "image"), false, JSON.stringify(config));
    assert.equal(Object.hasOwn(config, "network"), false, JSON.stringify(config));
  }
});

// ---------------------------------- Dockerfile.inspector: dependencies

// What `network: true` used to stand in for. The check box has no
// network at all now, so a recognized lockfile becomes a real install
// step at build time instead of a key asking to fetch at check time.
test("propose: a package-lock.json becomes an npm ci install step at build time", () => {
  const { dockerfile, stderr } = propose({
    checkScript: "#!/bin/sh\nset -e\nnpm test\n",
    packageJson: pkg({ dependencies: { tsx: "^4.19.0" } }),
    packageLock: true,
  });

  assert.ok(dockerfile.includes("COPY package.json package-lock.json /deps/"), dockerfile);
  assert.ok(dockerfile.includes("RUN cd /deps && npm ci"), dockerfile);
  assert.ok(stderr.includes("Dockerfile.inspector dependencies: npm ci from package-lock.json"), stderr);
});

test("propose: a go.sum becomes a go mod download step at build time", () => {
  const { dockerfile, stderr } = propose({
    goMod: "module example.com/app\n\ngo 1.22\n\nrequire github.com/x/y v1.2.3\n",
    goSum: true,
  });

  assert.ok(dockerfile.includes("COPY go.mod go.sum /deps/"), dockerfile);
  assert.ok(dockerfile.includes("RUN cd /deps && go mod download"), dockerfile);
  assert.ok(stderr.includes("dependencies: go mod download from go.sum"), stderr);
});

// The other half of the mechanism, on the one route where nothing
// writes check.sh for the Client: `npm ci` at build time lands in /deps,
// not in the checkout, so a check.sh that links nothing in finds no
// node_modules and has no network to fix that.
test("propose: a node project is told its own check.sh has to link /deps/node_modules in", () => {
  const { stderr } = propose({
    checkScript: "#!/bin/sh\nset -e\nnpm test\n",
    packageJson: pkg({ dependencies: { tsx: "^4.19.0" } }),
    packageLock: true,
  });

  assert.ok(stderr.includes("  check.sh: whatever this check ends up running"), stderr);
  assert.ok(stderr.includes("ln -s /deps/node_modules node_modules"), stderr);
});

// A Go module cache lives in the image, outside the checkout, where the
// toolchain already looks - there is nothing to link, so saying there is
// would be noise.
test("propose: a go project is told nothing about linking, having nothing to link", () => {
  const { stderr } = propose({
    goMod: "module example.com/app\n\ngo 1.22\n\nrequire github.com/x/y v1.2.3\n",
    goSum: true,
  });

  assert.ok(!stderr.includes("  check.sh:"), stderr);
});

// One instruction, in one place: a fetching check's warning already
// carries it, so the note does not repeat it underneath.
test("propose: the linking instruction is not said twice when the check also fetches", () => {
  const { stderr } = propose({
    checkScript: "#!/bin/sh\nset -e\nnpm ci\nnpm test\n",
    packageLock: true,
  });

  assert.ok(stderr.includes("  warning: the check runs `npm ci`"), stderr);
  assert.ok(stderr.includes("ln -s /deps/node_modules node_modules"), stderr);
  assert.ok(!stderr.includes("  check.sh: whatever"), stderr);
});

// A check that fetches cannot fetch at all in that box, whatever else is
// true - named on its own line rather than answered with a key that no
// longer exists.
test("propose: a check that fetches its dependencies is warned about, quoting its own spelling", () => {
  for (const [body, quoted] of [
    ["npm i\nnpm test\n", "`npm i`"],
    ["go mod tidy\ngo test ./...\n", "`go mod tidy`"],
    ["pip3  install -r requirements.txt\npytest\n", "`pip3 install`"],
  ]) {
    const { stderr } = propose({ checkScript: `#!/bin/sh\nset -e\n${body}` });
    assert.ok(stderr.includes("  warning: the check runs"), stderr);
    assert.ok(stderr.includes(quoted), `${quoted} should be quoted verbatim: ${stderr}`);
    assert.ok(stderr.includes("no network at all"), stderr);
  }
});

test("propose: a check that fetches nothing gets no warning", () => {
  const { stderr } = propose({ checkScript: "#!/bin/sh\nexit 0\n" });

  assert.ok(!stderr.includes("warning:"), stderr);
});

test("propose: a test script that installs first is seen through `npm test`", () => {
  const { config, stderr } = propose({
    packageJson: pkg({ scripts: { test: "npm ci && vitest run" }, dependencies: { a: "1" } }),
  });

  assert.equal(config.check, "npm test");
  assert.ok(stderr.includes("  warning: the check runs `npm ci`"), stderr);
});

// The trap worth naming: nothing here invents an install step for a
// shape it does not recognize. A project declaring dependencies with no
// lockfile is told so, in the notes and in the file itself.
test("propose: declared dependencies with no lockfile are named, never guessed at", () => {
  const { dockerfile, stderr } = propose({
    packageJson: pkg({ scripts: { test: "node --test" }, dependencies: { a: "1" }, devDependencies: { b: "2" } }),
  });

  assert.ok(stderr.includes("declares 2 dependencies"), stderr);
  assert.ok(stderr.includes("no package-lock.json"), stderr);
  assert.ok(!dockerfile.includes("RUN "), "no install step is invented");
  assert.ok(dockerfile.includes("Add what ./check.sh needs here"), dockerfile);
});

test("propose: a Go module's require entries with no go.sum are named the same way", () => {
  const { dockerfile, stderr } = propose({
    goMod: "module example.com/app\n\ngo 1.22\n\nrequire github.com/x/y v1.2.3\n",
  });

  assert.ok(stderr.includes("no go.sum"), stderr);
  assert.ok(!dockerfile.includes("RUN "), "no install step is invented");
});

// The second file is deliberately not on stdout: that stream is the one
// document `fabrica register <path> > .inspector.json` writes.
test("propose: the Dockerfile rides on stderr, never on stdout", () => {
  const { json, stderr, dockerfile } = propose({ packageLock: true });

  assert.ok(!json.includes("FROM"), json);
  assert.ok(stderr.includes(dockerfile.trimEnd()), stderr);
});

// ------------------------------------------- the Ruby shape (issue #324)

// The suite is named inside check.sh, not in .inspector.json: it only
// passes with the servers started and the test database created around
// it, and the script is the only place that preamble can live.
test("propose: a Rails repository's check is ./check.sh, holding the suite the lockfile names", () => {
  const { config, stderr, checkScript } = propose(RAILS);

  assert.equal(config.check, "./check.sh");
  assert.ok(stderr.includes("rspec"), stderr);
  assert.ok(stderr.includes("only passes with this project's own servers started"), stderr);
  assert.ok(checkScript !== null, "the script it names is part of the proposal");
  assert.ok(checkScript.includes("bundle exec rspec\n"), checkScript ?? "");
});

test("propose: with no rspec in the lockfile, the suite is the Rails framework's own command", () => {
  const { stderr, checkScript } = propose({
    ...RAILS,
    gemfileLock: "GEM\n  specs:\n    pg (1.5.6)\n    rails (7.1.3.2)\n",
  });

  assert.ok(checkScript?.endsWith("bin/rails test\n"), checkScript ?? "");
  assert.ok(stderr.includes("framework's own test command"), stderr);
});

// Nothing to start and no database to create, so the command stands on
// its own and the config can name it - the same rule `npm test` follows.
test("propose: a plain Ruby project with no servers has its command named in the config", () => {
  const { config, checkScript } = propose({
    gemfileLock: "GEM\n  specs:\n    rake (13.2.1)\n    rspec-core (3.13.0)\n",
  });

  assert.equal(config.check, "bundle exec rspec");
  assert.equal(checkScript, null, "there is no preamble to propose a script for");
});

test("propose: an exact .ruby-version derives the official Ruby image for that version", () => {
  const { dockerfile, stderr } = propose(RAILS);

  assert.ok(dockerfile.includes("FROM ruby:3.3.4"), dockerfile);
  assert.ok(stderr.includes("Dockerfile.inspector FROM: ruby:3.3.4"), stderr);
  assert.ok(stderr.includes(".ruby-version pins ruby 3.3.4"), stderr);
});

// Three files can pin it, asked in the order issue #324 names them.
test("propose: the Ruby version falls back to the Gemfile's line, then to the lockfile's", () => {
  const fromGemfile = propose({ ...RAILS, rubyVersion: null });
  assert.ok(fromGemfile.dockerfile.includes("FROM ruby:3.3.4"), fromGemfile.dockerfile);
  assert.ok(fromGemfile.stderr.includes("Gemfile's ruby line pins ruby 3.3.4"), fromGemfile.stderr);

  // Gemfile.lock's RUBY VERSION carries a patch level (3.3.4p94) that
  // belongs to a build of Ruby rather than to an image tag.
  const fromLock = propose({ ...RAILS, rubyVersion: null, gemfile: `source "https://rubygems.org"\n` });
  assert.ok(fromLock.dockerfile.includes("FROM ruby:3.3.4"), fromLock.dockerfile);
  assert.ok(fromLock.stderr.includes("RUBY VERSION pins ruby 3.3.4"), fromLock.stderr);
});

test("propose: a Ruby project pinning no exact version gets a loud placeholder, never a guess", () => {
  for (const rubyVersion of [null, "3.3\n", "~> 3.3.0\n", "jruby-9.4.5.0\n"]) {
    const { dockerfile } = propose({
      gemfileLock: "GEM\n  specs:\n    rake (13.2.1)\n",
      rubyVersion,
      gemfile: `source "https://rubygems.org"\nruby "~> 3.3.0"\n`,
    });
    const image = /^FROM\s+(\S+)/m.exec(dockerfile)?.[1] ?? "";
    assert.ok(image.startsWith(IMAGE_PLACEHOLDER_PREFIX), `${rubyVersion}: ${dockerfile}`);
    assert.notEqual(image, image.toLowerCase(), `${image} should carry uppercase, which Docker rejects`);
  }
});

// A Rails application with a JavaScript bundler declares both, and the
// box has to be the one that runs the suite.
test("propose: Ruby signals win over a package.json beside them, in every field", () => {
  const { config, dockerfile, stderr } = propose({
    ...RAILS,
    packageJson: pkg({ engines: { node: "24.18.0" }, scripts: { test: "vitest run" } }),
    packageLock: true,
  });

  assert.equal(config.check, "./check.sh", "not npm test");
  assert.ok(dockerfile.includes("FROM ruby:3.3.4"), dockerfile);
  assert.ok(dockerfile.includes("bundle install"), dockerfile);
  assert.ok(!dockerfile.includes("npm ci"), dockerfile);
  // ...and the lockfile that went uninstalled is named, not dropped.
  assert.ok(stderr.includes("there is a package-lock.json at the root too, and nothing installs it"), stderr);
});

test("propose: a Gemfile.lock becomes a bundle install step, with the servers the gems name", () => {
  const { dockerfile, stderr } = propose(RAILS);

  assert.ok(stderr.includes("Dockerfile.inspector dependencies: bundle install from Gemfile.lock"), stderr);
  assert.ok(dockerfile.includes("COPY Gemfile Gemfile.lock .ruby-version /deps/"), dockerfile);
  assert.ok(dockerfile.includes("RUN cd /deps && bundle install"), dockerfile);
  assert.ok(dockerfile.includes("postgresql libpq-dev redis-server"), dockerfile);
});

test("propose: a Gemfile with no Gemfile.lock is named, and no install step is invented", () => {
  const { dockerfile, stderr } = propose({ gemfile: RAILS_GEMFILE });

  assert.ok(stderr.includes("no Gemfile.lock at the root"), stderr);
  assert.ok(!dockerfile.includes("RUN "), "no install step is invented");
});

// The one field that stops being omitted, and not from a signal: a check
// that boots a database and runs a Rails suite is in a different order
// of magnitude, so Inspector's own default would be left deciding
// whether a real suite is killed mid-run. 30 minutes, by Client ruling.
test("propose: a check that boots its own servers is given a longer timeout, with its reason", () => {
  const { config, stderr } = propose(RAILS);

  assert.equal(config.timeoutSeconds, 1800);
  assert.ok(stderr.includes("timeoutSeconds: 1800 -"), stderr);
  assert.ok(stderr.includes("different order of magnitude"), stderr);
});

test("propose: a Ruby project with no servers to boot still gets no timeout at all", () => {
  const { config, stderr } = propose({ gemfileLock: "GEM\n  specs:\n    rake (13.2.1)\n" });

  assert.equal(Object.hasOwn(config, "timeoutSeconds"), false);
  assert.ok(stderr.includes("timeoutSeconds: omitted"), stderr);
});

// Issue #324, in its own words: "Browser/system tests are out of scope;
// register says so in its notes when it sees them."
test("propose: browser-driven tests in the lockfile are named as out of scope", () => {
  const { stderr } = propose(RAILS);

  assert.ok(stderr.includes("  note: Gemfile.lock names capybara"), stderr);
  assert.ok(stderr.includes("browser-driven system tests"), stderr);
  assert.ok(stderr.includes("nothing here installs a browser"), stderr);
});

test("propose: a lockfile with no browser gem is told nothing about system tests", () => {
  const { stderr } = propose({ ...RAILS, gemfileLock: "GEM\n  specs:\n    pg (1.5.6)\n    rspec-core (3.13.0)\n" });

  assert.ok(!stderr.includes("browser-driven"), stderr);
});

// Only PostgreSQL and Redis are recognized, so another database engine
// is a gap - named, rather than left to a check with nothing to connect
// to.
test("propose: a database this shape installs no server for is named", () => {
  const { stderr } = propose({ ...RAILS, gemfileLock: "GEM\n  specs:\n    mysql2 (0.5.6)\n    rspec-core (3.13.0)\n" });

  assert.ok(stderr.includes("  note: Gemfile.lock names mysql2"), stderr);
  assert.ok(stderr.includes("installs no server for it"), stderr);
});

// Fabrica's own containment runs every container as the host user, so
// the one proving run cannot start these servers - said here rather than
// met as a permission error.
test("propose: the root a server needs, and the proving run that has none, are both named", () => {
  const { stderr } = propose(RAILS);

  assert.ok(stderr.includes("needs the check box to run as root"), stderr);
  assert.ok(stderr.includes("cannot prove here"), stderr);
});

// The proposal is three files for this shape, and still exactly one
// document on stdout: the other two ride on stderr for the Client to
// copy.
test("propose: the proposed check.sh rides on stderr too, never on stdout", () => {
  const { json, stderr, checkScript, notes } = propose(RAILS);

  assert.ok(!json.includes("#!/bin/sh"), json);
  assert.ok(stderr.includes(checkScript?.trimEnd() ?? ""), stderr);
  assert.ok(notes[0].includes("a proposal of three files"), notes[0]);
  assert.ok(stderr.includes("chmod +x check.sh"), stderr);
});

test("propose: a Rails proposal still names each field exactly once", () => {
  const { notes } = propose(RAILS);

  for (const key of [
    "check",
    "timeoutSeconds",
    "protectedPaths",
    "Dockerfile.inspector FROM",
    "Dockerfile.inspector dependencies",
  ]) {
    const lines = notes.filter((line) => line.startsWith(`  ${key}: `));
    assert.equal(lines.length, 1, `expected exactly one line for ${key}, got ${lines.length}`);
  }
});

// check.sh wins over every other signal, here as everywhere - and the
// Ruby suite it does not run is named rather than dropped.
test("propose: an existing check.sh beats the Ruby signals, naming the disagreement", () => {
  const { config, stderr, checkScript } = propose({ ...RAILS, checkScript: "#!/bin/sh\nmake verify\n" });

  assert.equal(config.check, "./check.sh");
  assert.equal(checkScript, null, "the repository's own script is never rewritten for it");
  assert.ok(stderr.includes("disagreement:"), stderr);
  assert.ok(stderr.includes("bundle exec rspec"), stderr);
});

test("propose: a check.sh that does run the Ruby suite is no disagreement", () => {
  for (const body of ["bundle exec rspec\n", "bin/rails test\n", "bundle exec rake\n"]) {
    const { stderr } = propose({ ...RAILS, checkScript: `#!/bin/sh\nset -e\n${body}` });
    assert.ok(!stderr.includes("disagreement:"), `${body}: ${stderr}`);
  }
});

// ---------------------------------------------- timeout and protection

test("propose: timeoutSeconds is always omitted, and says why on stderr", () => {
  for (const signals of [{}, { checkScript: "#!/bin/sh\nexit 0\n" }, { packageJson: pkg({ scripts: {} }) }]) {
    const { config, stderr } = propose(signals);
    assert.equal(Object.hasOwn(config, "timeoutSeconds"), false);
    assert.ok(stderr.includes("timeoutSeconds: omitted"), stderr);
    assert.ok(stderr.includes("how long the check takes"), stderr);
  }
});

test("propose: a file-path check is the one protected path, and nothing else is listed", () => {
  const { config, stderr } = propose({ checkScript: "#!/bin/sh\nexit 0\n" });

  assert.deepEqual(config.protectedPaths, ["check.sh"]);
  assert.ok(stderr.includes("protectedPaths: check.sh"), stderr);
  // The gate protects these on its own (Client ruling) - a deliberate
  // difference from scaffold.ts's protectedPathsFor, which always lists
  // .inspector.json next to check.sh.
  assert.ok(!(config.protectedPaths as string[]).includes(".inspector.json"), stderr);
  assert.ok(!(config.protectedPaths as string[]).some((p) => p.includes(".github")), stderr);
});

test("propose: an indirect check lists nothing, and says the decision is the Client's", () => {
  const { config, stderr } = propose({ packageJson: pkg({ scripts: { test: "node --test" } }) });

  assert.equal(Object.hasOwn(config, "protectedPaths"), false);
  assert.ok(stderr.includes("protectedPaths: omitted"), stderr);
  assert.ok(stderr.includes("yours to decide"), stderr);
});

// ------------------------------------------------- the document itself

test("propose: stdout is one valid, indented JSON document with no trailing newline", () => {
  const { json } = propose({ checkScript: "#!/bin/sh\nexit 0\n" });

  assert.doesNotThrow(() => JSON.parse(json));
  assert.ok(json.includes("\n  "), "should be indented, not a single-line blob");
  assert.ok(!json.endsWith("\n"), "the printer adds exactly one newline, so this must not carry its own");
});

// Same provenance rule as scaffold.test.ts: the only evidence of
// Inspector's schema in reach is this repository's own live config, so a
// proposal may never name a key it doesn't use.
test("propose: every key it can ever write is one this repository's own .inspector.json uses", () => {
  const ours = JSON.parse(readFileSync(join(repoRoot, ".inspector.json"), "utf8")) as Record<string, unknown>;
  const cases: Partial<ProposalSignals>[] = [
    {},
    {
      checkScript: "#!/bin/sh\nnpm ci && npm test\n",
      packageJson: pkg({ engines: { node: "24.18.0" } }),
      packageLock: true,
    },
    { packageJson: pkg({ scripts: { test: "node --test" } }) },
    { goMod: "module example.com/app\n\ngo 1.22\n", goSum: true },
    // The one shape that writes a timeoutSeconds of its own.
    RAILS,
  ];

  for (const signals of cases) {
    for (const key of Object.keys(propose(signals).config)) {
      assert.ok(Object.hasOwn(ours, key), `${key} is not a key this repository's own .inspector.json uses`);
    }
  }
});

test("propose: stderr opens by saying nothing was written, and closes with what to do next", () => {
  const { notes } = propose({ checkScript: "#!/bin/sh\nexit 0\n" });

  assert.ok(notes[0].startsWith("fabrica register: /srv/spending-app has no .inspector.json on origin/main"));
  assert.ok(notes[0].includes("Nothing was written"), notes[0]);
  const last = notes[notes.length - 1];
  assert.ok(last.includes("fabrica register /srv/spending-app"), last);
  assert.ok(last.includes("--check"), last);
  assert.ok(last.includes("--image"), last);
  // Both files to commit, since the config alone no longer says what the
  // check runs in.
  assert.ok(last.includes("Dockerfile.inspector"), last);
});

test("propose: one line per field, each naming its own key", () => {
  const { notes } = propose({ packageJson: pkg({ scripts: { test: "node --test" } }) });

  for (const key of [
    "check",
    "timeoutSeconds",
    "protectedPaths",
    "Dockerfile.inspector FROM",
    "Dockerfile.inspector dependencies",
  ]) {
    const lines = notes.filter((line) => line.startsWith(`  ${key}: `));
    assert.equal(lines.length, 1, `expected exactly one line for ${key}, got ${lines.length}`);
  }
});

test("propose: an unparseable package.json is simply not a signal", () => {
  const { config } = propose({ packageJson: "{ not json", goMod: "module example.com/app\n\ngo 1.22\n" });

  assert.equal(config.check, "go test ./...", "it falls through to the next signal rather than throwing");
});

// --------------------------------------------------- reading the signals

// The signals come off a commit, never the working tree: the ref asked
// about is origin's default branch, the same one the ".inspector.json
// present?" question was just asked against and the one a task's base
// commit is cut from.
test("readProposalSignals reads the named ref, not whatever is in the working tree", () => {
  const dir = makeFixtureRepo("exit 7", { inspector: false });
  writeFileSync(join(dir, PACKAGE_JSON), pkg({ engines: { node: "24.18.0" } }));
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "add package.json"], {
    cwd: dir,
  });

  // Now disagree with the commit in every direction, in the working tree
  // only: a rewritten check.sh, a deleted package.json, a new go.mod.
  writeFileSync(join(dir, "check.sh"), "#!/bin/sh\nexit 0\n");
  rmSync(join(dir, PACKAGE_JSON));
  writeFileSync(join(dir, GO_MOD), "module example.com/app\n\ngo 1.22\n");

  const signals = readProposalSignals(dir, "HEAD");

  assert.ok(signals.checkScript?.includes("exit 7"), "the committed check.sh, not the edited one");
  assert.ok(signals.packageJson?.includes("24.18.0"), "the committed package.json, not the deleted one");
  assert.equal(signals.goMod, null, "an uncommitted go.mod is not a signal");
});

test("readProposalSignals: a file that isn't there is null, not an error", () => {
  const signals = readProposalSignals(makeFixtureRepo("exit 0", { inspector: false }), "HEAD");

  assert.equal(signals.packageJson, null);
  assert.equal(signals.goMod, null);
  assert.equal(signals.packageLock, false);
  assert.equal(signals.goSum, false);
  assert.ok(signals.checkScript !== null, "makeFixtureRepo always commits a check.sh");
});

// A lockfile is read as presence alone - nothing here cares what is
// inside one, and a package-lock.json is routinely a megabyte - but it
// is still read off the commit, not the working tree.
test("readProposalSignals reads the lockfiles off the ref too", () => {
  const dir = makeFixtureRepo("exit 0", { inspector: false });
  writeFileSync(join(dir, "package-lock.json"), "{}\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "add lockfile"], { cwd: dir });
  // Uncommitted, so not a signal.
  writeFileSync(join(dir, GO_SUM), "example.com/x v1.0.0 h1:abc=\n");

  const signals = readProposalSignals(dir, "HEAD");

  assert.equal(signals.packageLock, true);
  assert.equal(signals.goSum, false, "an uncommitted go.sum is not a signal");
});

// Gemfile.lock is the one lockfile read in full rather than as presence
// alone, and bin/rails is the one signal that is a nested path - both
// still read off the commit, from a real Rails-shaped fixture.
test("readProposalSignals reads a Rails repository's four signals off the ref", () => {
  const dir = makeFixtureRepo("exit 0", { inspector: false });
  writeRailsFixture(dir);
  // The fixture's own check.sh goes: an existing one wins over every
  // other signal, which is proven elsewhere - what is being read here is
  // what a repository with no check.sh says instead.
  rmSync(join(dir, "check.sh"));
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "rails app"], { cwd: dir });

  const signals = readProposalSignals(dir, "HEAD");

  assert.equal(signals.gemfileLock, railsFixtureFiles()["Gemfile.lock"].trimEnd());
  assert.ok(signals.gemfile?.includes(`gem "rails"`), signals.gemfile ?? "");
  assert.equal(signals.rubyVersion, "3.3.4");
  assert.equal(signals.railsBin, true, "bin/rails is a nested path, and still read off the commit");

  // ...and the proposal built from them is the Rails one, end to end.
  const proposal = proposeInspectorConfig(signals, { projectPath: dir, defaultBranch: "main" });
  assert.ok(proposal.dockerfile.includes("FROM ruby:3.3.4"), proposal.dockerfile);
  assert.ok(proposal.checkScript?.includes("service postgresql start"), proposal.checkScript ?? "");
});

test("readProposalSignals: a repository with no Ruby in it has none of those signals", () => {
  const signals = readProposalSignals(makeFixtureRepo("exit 0", { inspector: false }), "HEAD");

  assert.equal(signals.gemfileLock, null);
  assert.equal(signals.gemfile, null);
  assert.equal(signals.rubyVersion, null);
  assert.equal(signals.railsBin, false);
});
