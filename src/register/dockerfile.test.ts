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
  inspectorDockerfile,
  knownNonRootUser,
} from "./dockerfile.ts";

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

test("dependencyShapeInTree reads the lockfiles a real checkout carries", () => {
  const empty = mkdtempSync(join(tmpdir(), "fabrica-dockerfile-"));
  assert.equal(dependencyShapeInTree(empty), null);

  const node = mkdtempSync(join(tmpdir(), "fabrica-dockerfile-node-"));
  writeFileSync(join(node, "package-lock.json"), "{}\n");
  assert.equal(dependencyShapeInTree(node)?.lockfile, "package-lock.json");

  const go = mkdtempSync(join(tmpdir(), "fabrica-dockerfile-go-"));
  writeFileSync(join(go, "go.sum"), "example.com/x v1.0.0 h1:abc=\n");
  assert.equal(dependencyShapeInTree(go)?.lockfile, "go.sum");
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
