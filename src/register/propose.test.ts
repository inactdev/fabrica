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
  proposeInspectorConfig,
  readProposalSignals,
  type ProposalSignals,
} from "./propose.ts";
import { GO_SUM } from "./dockerfile.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const NOTHING: ProposalSignals = {
  checkScript: null,
  packageJson: null,
  goMod: null,
  packageLock: false,
  goSum: false,
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
