// Fabrica's Node version is declared in four separate places, and
// before this nothing made them agree:
//
//   - `.node-version`, which nvm/fnm/asdf/mise read in a contributor's
//     shell and which `actions/setup-node` reads on CI
//     (.github/workflows/docker-tests.yml's `node-version-file`),
//   - `package.json`'s `engines.node`, which npm enforces for real
//     because `.npmrc` sets `engine-strict=true`,
//   - `Dockerfile.inspector`'s FROM tag, the Node the check box actually
//     runs (inspector builds that file) and the one `fabrica doctor`
//     refuses a mismatch against,
//   - `src/brain/adapters/docker/Dockerfile`'s node base image, the
//     Node a Worker writes and runs the project's check on.
//
// A fifth reader is bound here too (issue #322): the layer Fabrica puts
// on top of a project's own check image installs Node itself, and reads
// which version out of that same worker Dockerfile rather than carrying
// a copy of it.
//
// A bump that moves some of them and not the rest puts a contributor,
// CI, the check box and the Worker on different Node builds - which is
// precisely how a Node-version-specific failure hides (see
// notes/20261017-make-the-repo-declare-its-own-node-versi-sp.md for the
// round that cost). This file makes a partial bump fail the suite, so
// the only way through is to move all four together.
//
// Proved by reading the real files rather than by trusting a comment,
// the same approach src/relay/container/relay-image-digest.test.ts,
// src/foreman/inspector-stamp-workflow.test.ts and
// src/containment/docker-tests-workflow.test.ts take for their own
// declared-in-two-places facts.
//
// What this deliberately cannot prove: the Dockerfile's base image is
// pinned by digest (`FROM node@sha256:...`), and a digest carries no
// version. The version comes from the comment next to it that names the
// tag that digest resolves to - so a bump that changes the digest while
// leaving that comment alone is invisible here, and nothing offline can
// close that gap without a registry lookup. The comment is still the
// only record of which Node that digest is, so binding it is worth more
// than leaving it unbound.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pinnedNodeVersion } from "./doctor-command.ts";
import { machineLayer, pinnedMachineNodeVersion } from "../brain/index.ts";

const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOCKERFILE = join(CHECKOUT, "src", "brain", "adapters", "docker", "Dockerfile");

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

function nodeVersionFile(): string {
  return readFileSync(join(CHECKOUT, ".node-version"), "utf8").trim();
}

function enginesNode(): string {
  const pkg = JSON.parse(readFileSync(join(CHECKOUT, "package.json"), "utf8")) as {
    engines?: { node?: string };
  };
  return pkg.engines?.node ?? "";
}

/** The tag the Dockerfile says its digest-pinned base image resolves to
 * - `node:<x.y.z>-alpine`. Read from the file's own source, so a reword
 * that drops that spelling fails loudly here rather than quietly
 * un-pinning this check. */
function dockerfileBaseVersion(dockerfile: string): string | null {
  return /\bnode:(\d+\.\d+\.\d+)-alpine\b/.exec(dockerfile)?.[1] ?? null;
}

/** Every Node version the Dockerfile mentions anywhere, in any of the
 * spellings it uses: `node:24.18.0-alpine`, `cimg/node:24.18.0`,
 * `Node v24.18.0`. One file contradicting itself is drift too. */
function allDockerfileVersions(dockerfile: string): string[] {
  return [...dockerfile.matchAll(/node[:\s]v?(\d+\.\d+\.\d+)/gi)].map((m) => m[1]);
}

test("all four Node declarations name the same version", () => {
  const expected = nodeVersionFile();
  const dockerfile = readFileSync(DOCKERFILE, "utf8");

  assert.ok(
    /^FROM node@sha256:[0-9a-f]+/m.test(dockerfile),
    "expected the worker Dockerfile to pin its node base image by digest on its own FROM line"
  );

  const pins: Record<string, string | null> = {
    ".node-version": expected,
    "package.json's engines.node": enginesNode(),
    "Dockerfile.inspector's FROM tag": pinnedNodeVersion(),
    "the worker Dockerfile's node base image": dockerfileBaseVersion(dockerfile),
  };

  for (const [source, found] of Object.entries(pins)) {
    assert.equal(
      found,
      expected,
      `${source} says ${found ?? "nothing"}, but .node-version says ${expected} - a Node bump has to move all four together`
    );
  }
});

test(".node-version and engines.node name an exact version, never a bare major", () => {
  // A bare major is not a pin. `.node-version` holding `24` lets a
  // version manager install whichever 24.x it feels like - fnm installed
  // 24.22.0 from it, which `fabrica doctor` then refused against
  // .inspector.json's 24.18.0, leaving the repo's own declaration and
  // the repo's own preflight in direct disagreement. engines.node has
  // the same hole: `24` is satisfied by every 24.x, so engine-strict
  // enforces nothing about which one.
  for (const [source, value] of Object.entries({
    ".node-version": nodeVersionFile(),
    "package.json's engines.node": enginesNode(),
  })) {
    assert.match(
      value,
      EXACT_VERSION,
      `${source} must name an exact major.minor.patch version, not ${JSON.stringify(value)}`
    );
  }
});

test("the per-project machine layer installs that same Node version", () => {
  // Issue #322: a project carrying its own Dockerfile.inspector gets its
  // machine image layered on top of it, and that layer installs Node
  // itself (the project's base may well have none). Its version is read
  // out of the worker Dockerfile - the one place both pins live - rather
  // than copied, and this is what makes a half-done bump fail here too:
  // a machine writing on one Node while the check box runs another is the
  // same hiding place the four declarations above exist to close.
  const expected = nodeVersionFile();

  assert.equal(pinnedMachineNodeVersion(), expected, "the machine layer's Node pin has to be the same one");
  const layer = machineLayer();
  assert.ok(layer.includes(`version="${expected}"`), `the layer installs Node ${expected}`);
  assert.deepEqual(
    [...new Set([...layer.matchAll(/node-v?(\d+\.\d+\.\d+)/gi)].map((m) => m[1]))],
    [],
    "the layer must build its tarball name from the pinned version, never from a second literal"
  );
});

test("the worker Dockerfile never names a second Node version", () => {
  const dockerfile = readFileSync(DOCKERFILE, "utf8");
  const found = allDockerfileVersions(dockerfile);
  assert.ok(found.length > 0, "expected the worker Dockerfile to name the Node version its base image is");
  assert.deepEqual(
    [...new Set(found)],
    [nodeVersionFile()],
    `the worker Dockerfile mentions ${JSON.stringify([...new Set(found)])}; every Node version it names must be .node-version's`
  );
});
