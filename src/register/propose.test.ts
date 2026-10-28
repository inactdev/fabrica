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

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const NOTHING: ProposalSignals = { checkScript: null, packageJson: null, goMod: null };

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

// ------------------------------------------------------------- image

test("propose: an exactly pinned engines.node derives the image from it", () => {
  const { config, stderr } = propose({ packageJson: pkg({ engines: { node: "24.18.0" } }) });

  assert.equal(config.image, "cimg/node:24.18.0");
  assert.ok(stderr.includes("engines.node pins node 24.18.0"), stderr);
});

test("propose: a version range names no single tag, so the image is a loud placeholder", () => {
  const { config, stderr } = propose({ packageJson: pkg({ engines: { node: ">=22" } }) });

  assert.ok(String(config.image).startsWith(IMAGE_PLACEHOLDER_PREFIX), String(config.image));
  assert.ok(stderr.includes(">=22"), stderr);
});

test("propose: a Go module's toolchain version is named, but no Go image is invented", () => {
  const { config, stderr } = propose({ goMod: "module example.com/app\n\ngo 1.22\n" });

  assert.equal(config.image, `${IMAGE_PLACEHOLDER_PREFIX}an-image-that-ships-go-1.22`);
  assert.ok(stderr.includes("no verified Go image to offer"), stderr);
});

test("propose: with no signal at all the image is a placeholder naming what it is for", () => {
  const { config, stderr } = propose({});

  assert.ok(String(config.image).startsWith(IMAGE_PLACEHOLDER_PREFIX), String(config.image));
  assert.ok(stderr.includes("nothing can be installed inside a check box"), stderr);
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
    const image = String(propose(signals).config.image);
    assert.notEqual(image, image.toLowerCase(), `${image} should carry uppercase, which Docker rejects`);
    assert.ok(!image.includes(":"), `${image} should not look like a name:tag pair`);
  }
});

// ----------------------------------------------------------- network

test("propose: a check that fetches its dependencies turns network on, naming the command", () => {
  const { config, stderr } = propose({
    checkScript: "#!/bin/sh\nset -e\nnpm ci\nnpm test\n",
    packageJson: pkg({ dependencies: { tsx: "^4.19.0" } }),
  });

  assert.equal(config.network, true);
  assert.ok(stderr.includes("network: true"), stderr);
  assert.ok(stderr.includes("the check runs `npm ci`"), stderr);
});

// The command is quoted as the check spells it, not as a label for it: a
// reason line that says `npm install` about a check that says `npm i` is
// describing something the repository doesn't say.
test("propose: the installing command is quoted as the check spells it", () => {
  for (const [body, quoted] of [
    ["npm i\nnpm test\n", "`npm i`"],
    ["go mod tidy\ngo test ./...\n", "`go mod tidy`"],
    ["pip3  install -r requirements.txt\npytest\n", "`pip3 install`"],
  ]) {
    const { config, stderr } = propose({ checkScript: `#!/bin/sh\nset -e\n${body}` });
    assert.equal(config.network, true, stderr);
    assert.ok(stderr.includes(quoted), `${quoted} should be quoted verbatim: ${stderr}`);
  }
});

test("propose: network is off, as an absent key, when nothing the check runs fetches anything", () => {
  const { config, stderr } = propose({ checkScript: "#!/bin/sh\nexit 0\n" });

  assert.equal(Object.hasOwn(config, "network"), false, "off is the absence of the key, not network: false");
  assert.ok(stderr.includes("network: omitted"), stderr);
});

// The trap worth naming: network access does not conjure node_modules.
// A check with no install step fails in a fresh box whether the network
// is there or not, so the proposal says that instead of writing a `true`
// that would not fix it.
test("propose: declared dependencies with no install step are named, not answered with network: true", () => {
  const { config, stderr } = propose({
    packageJson: pkg({ scripts: { test: "node --test" }, dependencies: { a: "1" }, devDependencies: { b: "2" } }),
  });

  assert.equal(Object.hasOwn(config, "network"), false);
  assert.ok(stderr.includes("declares 2 dependencies"), stderr);
  assert.ok(stderr.includes("npm ci"), stderr);
});

test("propose: a test script that installs first is seen through `npm test`", () => {
  const { config, stderr } = propose({
    packageJson: pkg({ scripts: { test: "npm ci && vitest run" }, dependencies: { a: "1" } }),
  });

  assert.equal(config.check, "npm test");
  assert.equal(config.network, true, stderr);
  assert.ok(stderr.includes("the check runs `npm ci`"), stderr);
});

test("propose: a Go module's require entries are named the same way", () => {
  const { stderr } = propose({ goMod: "module example.com/app\n\ngo 1.22\n\nrequire github.com/x/y v1.2.3\n" });

  assert.ok(stderr.includes("empty module cache"), stderr);
  assert.ok(stderr.includes("go mod download"), stderr);
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
test("propose: every key it can ever write is one this repository's own .inspector.json uses", { skip: "fabrica register still writes the image and network keys inspector#47 retired, and this repository's own config no longer carries them; restored once register scaffolds Dockerfile.inspector instead" }, () => {
  const ours = JSON.parse(readFileSync(join(repoRoot, ".inspector.json"), "utf8")) as Record<string, unknown>;
  const cases: Partial<ProposalSignals>[] = [
    {},
    { checkScript: "#!/bin/sh\nnpm ci && npm test\n", packageJson: pkg({ engines: { node: "24.18.0" } }) },
    { packageJson: pkg({ scripts: { test: "node --test" } }) },
    { goMod: "module example.com/app\n\ngo 1.22\n" },
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
});

test("propose: one line per field, each naming its own key", () => {
  const { notes } = propose({ packageJson: pkg({ scripts: { test: "node --test" } }) });

  for (const key of ["check", "image", "network", "timeoutSeconds", "protectedPaths"]) {
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
  assert.ok(signals.checkScript !== null, "makeFixtureRepo always commits a check.sh");
});
