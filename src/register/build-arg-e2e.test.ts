// A version read out of the repository and passed to the check-image
// build, end to end, against the real installed Inspector (issue #355).
//
// Everything else about this issue is asserted on text Fabrica writes -
// the `ARG` line, the `buildArgs` entry, the `--build-arg` argv - and
// none of it can tell you whether Inspector really reads that entry,
// really reads the file at the commit under check, and really hands the
// value to its own `docker build`. That is the half this file runs for
// real.
//
// **This test fails until `.github/workflows/docker-tests.yml`'s
// Inspector pin moves to the commit that teaches Inspector the
// `buildArgs` key** (task 1 of issue #355's pair). An Inspector without
// it reads past the key, passes no `--build-arg`, and the build falls
// back to the `ARG` default - which is this test's own failure message,
// naming the pin. That is deliberate, it is the same shape
// `build-secret-e2e.test.ts` had while inspector#87 was in flight, and
// the fix is the pin, never a workaround in this file.
//
// Why it lives under `src/register/`: `.github/workflows/
// docker-tests.yml`'s path gate names `src/register/*`, so a test placed
// here runs on the merge path for any change to the files `register`
// writes - the same reasoning `build-secret-e2e.test.ts`'s own header
// gives for sitting here.
//
// It skips only when Docker is absent, exactly like its two siblings:
// no `inspector` on PATH, a failed build, a red check - each FAILS,
// naming what happened.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_ARGS_KEY } from "../buildargs/index.ts";
import { INSPECTOR_CONFIG } from "../inspector/index.ts";
import { DOCKERFILE_INSPECTOR } from "./dockerfile.ts";
import { FIXTURE_IMAGE } from "./helpers/rails-app-fixture.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";

/** The version this repository declares for itself, and the one the
 * check box therefore has to be built with. Deliberately not the
 * version the Dockerfile's `ARG` defaults to: if the two agreed, an
 * Inspector that passed nothing at all would look identical to one that
 * passed the right thing. */
const DECLARED_VERSION = "3.4.13";

/** What the Dockerfile hard-codes as its `ARG` default - the version it
 * carried before the conversion, left there so a build that passes
 * nothing still builds. */
const PINNED_VERSION = "3.4.8";

/** The argument the file reads its version through, and the file it
 * comes from - the pair `fabrica register` writes. */
const ARG = "RUBY_VERSION";
const VERSION_FILE = ".ruby-version";

/** Where the build step records the value it was handed, so the version
 * travels out of the box through Inspector's own report - the only
 * channel this test has into it. */
const WITNESS = "/fabrica-build-arg-witness";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * The terms folder's `Dockerfile.inspector`, in the shape the
 * conversion writes: the argument declared above the first `FROM` with
 * the old version as its default, then re-declared inside the stage so
 * the step below can record what the build was really given.
 *
 * The `FROM` stays a fixed image on purpose. Resolving the tag itself
 * through the argument would need two real language images pulled to
 * prove one substitution, and that substitution is already proved
 * against a real builder, cheaply, in
 * `src/buildargs/arg-form-build.test.ts`. What only the real Inspector
 * can answer - and what this file is for - is whether the value reaches
 * the build at all.
 */
function termsDockerfile(): string {
  return [
    `ARG ${ARG}=${PINNED_VERSION}`,
    `FROM ${FIXTURE_IMAGE}`,
    // A build argument declared before the first FROM is outside every
    // stage, so a step inside one has to declare it again to read it -
    // BuildKit's own Dockerfile reference says so, and this is the line
    // that relies on it.
    `ARG ${ARG}`,
    `RUN printf '%s' "$${ARG}" > ${WITNESS}`,
    "",
  ].join("\n");
}

test("the real Inspector reads a declared version out of the repository and builds its check box with it", { timeout: 45 * 60 * 1000 }, (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");

  // The repository declares the version - and nothing else about any of
  // this is in it: a work-mode repository is one nothing of Fabrica's
  // may be committed to.
  const repo = makeFixtureRepo("exit 0", { inspector: false });
  writeFileSync(join(repo, VERSION_FILE), `${DECLARED_VERSION}\n`);
  execFileSync("git", ["add", "--", VERSION_FILE], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-qm", "declare this repository's own ruby version"], { cwd: repo, stdio: "ignore" });

  const terms = mkdtempSync(join(tmpdir(), "fabrica-build-arg-terms-"));
  writeFileSync(
    join(terms, INSPECTOR_CONFIG),
    `${JSON.stringify({ check: "sh /terms/probe.sh", [BUILD_ARGS_KEY]: { [ARG]: { file: VERSION_FILE } } }, null, 2)}\n`
  );
  writeFileSync(join(terms, DOCKERFILE_INSPECTOR), termsDockerfile());
  // The check reports what the build step recorded rather than passing
  // silently, the same way `build-secret-e2e.test.ts`'s probe does.
  writeFileSync(
    join(terms, "probe.sh"),
    `#!/bin/sh\nprintf 'version seen by the build step: %s\\n' "$(cat ${WITNESS})"\n`
  );

  const run = spawnSync("inspector", ["-repo", repo, "-branch", "fabrica/build-arg-e2e", "-terms", terms], {
    encoding: "utf8",
    // Nothing of this machine's beyond what docker itself needs: no
    // GITHUB_TOKEN to publish with, so Inspector refuses after the
    // check has already run and been reported.
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    timeout: 45 * 60 * 1000,
  });
  if (run.error !== undefined && (run.error as NodeJS.ErrnoException).code === "ENOENT") {
    assert.fail(
      `\`inspector\` is not on PATH, and this test does not skip for that - it is the whole point of the test. ` +
        `Install the pinned commit the way .github/workflows/docker-tests.yml does.`
    );
  }

  const reportPath = join(repo, ".inspector", "latest.json");
  assert.ok(
    existsSync(reportPath),
    `inspector wrote no report at all, so it refused before it ever ran the check (exit ${run.status}):\n` +
      `${run.stdout}\n${run.stderr}`
  );
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as { outcome?: string; output?: string };
  const detail = `outcome=${report.outcome}\n${report.output ?? "(no output recorded)"}`;

  assert.equal(report.outcome, "green", detail);
  assert.match(
    report.output ?? "",
    new RegExp(`version seen by the build step: ${DECLARED_VERSION.replace(/\./g, "\\.")}\\b`),
    `the check image's build step was handed something other than the version ${VERSION_FILE} declares - the ` +
      `usual cause is an Inspector older than issue #355's own half, which reads past the ${BUILD_ARGS_KEY} key ` +
      `and leaves the ARG default (${PINNED_VERSION}) standing. The fix is the pin in ` +
      `.github/workflows/docker-tests.yml:\n${detail}`
  );
});
