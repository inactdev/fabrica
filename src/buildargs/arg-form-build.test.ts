// A real `docker build` of the argument form, against a real daemon
// (issue #355).
//
// Why this file exists: everything else about this issue is text -
// which `ARG` line is written, which `--build-arg` flags are passed,
// which stamp is hashed. All of it rests on one fact about Docker
// itself, and the whole feature is worthless if that fact is wrong: a
// build argument declared above the first `FROM`, with a default, is
// overridden by `--build-arg`, and the image really is built on the
// version that argument carries. BuildKit's own Dockerfile reference
// says so ("FROM instructions support variables that are declared by
// any ARG instructions that occur before the first FROM", and `ARG
// CODE_VERSION=latest` / `FROM base:${CODE_VERSION}` is its own
// example), but this project's rule is to verify rather than reason
// where a real check is available - the same reason
// src/brain/adapters/machine-image-build.test.ts hands the generated
// machine Dockerfile to a real builder.
//
// What it builds is deliberately tiny and deliberately not the machine
// layer: two `busybox` tags, a few megabytes each, so this costs
// seconds rather than the minutes a language base plus Fabrica's own
// layer costs. The layer is proved elsewhere, on real language bases;
// what is under test here is the `FROM`/`ARG`/`--build-arg` triangle,
// rendered by this module's own `argFormRef` and `buildArgFlags` rather
// than by a string typed into this test.
//
// Skips - loudly, with a banner, never fails - where there is no Docker
// daemon, matching src/containment/run.test.ts's own convention. It runs
// for real in the `docker-tests` CI job, which fails if Docker is not
// genuinely there, so a skip can never be the whole story on the merge
// path.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArgFlags } from "./resolve.ts";
import { argFormRef, splitImageVersion, versionArgFor } from "./versions.ts";

/** Two real tags of one tiny image. The "declared" one is what the
 * repository's own version file says; the "pinned" one is what the
 * Dockerfile used to hard-code and is left as the argument's default,
 * so the build has to come out on the first and not the second. */
const PINNED = "1.36.1";
const DECLARED = "1.37.0";
const IMAGE = "busybox";

/** The argument this test drives Docker with - named here, since
 * `busybox` is not a language in the version table and so has no
 * argument of its own. Everything else about the file is this module's
 * own rendering. */
const ARG = "BUSYBOX_VERSION";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Two small pulls and two trivial builds - seconds on a warm daemon,
 * and node:test's default timeout is not enough for a cold one. */
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

let ranForReal = false;
let skipReason: string | null = null;

after(() => {
  if (ranForReal) return;
  console.error(
    [
      "",
      "!".repeat(78),
      "!! REAL BUILD-ARGUMENT BUILD DID NOT RUN",
      "!! Nothing proved that a FROM carrying a build argument really builds",
      "!! on the version that argument carries - the one fact every part of",
      `!! issue #355 rests on. Reason: ${skipReason ?? "unknown"}`,
      "!! It runs for real in the docker-tests CI job.",
      "!".repeat(78),
      "",
    ].join("\n")
  );
});

test("a FROM in the argument form really builds on the version passed, not on its default", { timeout: BUILD_TIMEOUT_MS }, async (t) => {
  if (!dockerAvailable()) {
    skipReason = "Docker is not available on this machine";
    return t.skip(skipReason);
  }

  // The file, rendered the way the conversion renders one: the version
  // that was hard-coded becomes the default, and the reference becomes
  // the argument form.
  const split = splitImageVersion(`${IMAGE}:${PINNED}`);
  assert.ok(split, "the fixture's own tag has to be one this module reads as a version");
  const ref = argFormRef({
    family: { label: IMAGE, arg: ARG, images: [IMAGE], files: [] },
    image: split,
    declared: { file: ".fixture-version", value: DECLARED },
  });
  assert.equal(ref, `${IMAGE}:\${${ARG}}`);

  const dir = mkdtempSync(join(tmpdir(), "fabrica-arg-form-build-"));
  const dockerfile = join(dir, "Dockerfile");
  writeFileSync(dockerfile, [`ARG ${ARG}=${PINNED}`, `FROM ${ref}`, `RUN busybox | head -n 1 > /version.txt`, ""].join("\n"));

  const build = (tag: string, args: string[]): void => {
    execFileSync("docker", ["build", ...args, "-t", tag, "-f", dockerfile, dir], {
      stdio: ["ignore", "inherit", "inherit"],
    });
  };
  const versionIn = (tag: string): string =>
    execFileSync("docker", ["run", "--rm", "--entrypoint", "cat", tag, "/version.txt"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  const passed = "fabrica-arg-form-passed:latest";
  const defaulted = "fabrica-arg-form-default:latest";
  try {
    // The flags are this module's own, from the same function the real
    // build uses - not a hand-written `--build-arg` pair.
    const flags = buildArgFlags({ [ARG]: DECLARED });
    assert.deepEqual(flags, ["--build-arg", `${ARG}=${DECLARED}`]);
    build(passed, flags);
    ranForReal = true;
    assert.match(
      versionIn(passed),
      new RegExp(`v${DECLARED.replace(/\./g, "\\.")}`),
      `the image has to be built on the version the argument carried (${DECLARED}), not on the ARG default`
    );

    // And the other half of why the default is there at all: a build
    // that passes nothing still builds, on what the file used to
    // hard-code - so an Inspector that has never heard of `buildArgs`,
    // or a hand `docker build`, produces exactly what it produced
    // before the conversion rather than failing on `busybox:`.
    build(defaulted, []);
    assert.match(versionIn(defaulted), new RegExp(`v${PINNED.replace(/\./g, "\\.")}`));
  } finally {
    for (const tag of [passed, defaulted]) {
      try {
        execFileSync("docker", ["image", "rm", "-f", tag], { stdio: "ignore" });
      } catch {
        // Nothing to clean up for a build that never produced a tag.
      }
    }
  }
});

// Sanity on the fixture itself, with no daemon needed: the two tags this
// test drives Docker with are both versions this module would really
// act on, so a green run above is about the mechanism rather than about
// a reference that was never convertible.
test("the fixture's own tags are ones this module reads as versions", () => {
  const read = (path: string) => (path === ".ruby-version" ? `${DECLARED}\n` : null);
  assert.deepEqual(splitImageVersion(`${IMAGE}:${DECLARED}`), { image: IMAGE, version: DECLARED, suffix: "" });
  // And a language image on the same shape resolves end to end.
  assert.equal(versionArgFor(`ruby:${PINNED}`, read)?.declared.value, DECLARED);
});
