// A build secret, end to end, against real Docker and the real
// installed Inspector (issue #342).
//
// Everything else about build secrets is asserted on the *text* Fabrica
// writes - the config's key, the Dockerfile's mount line, the `docker
// build` argv. None of that can tell you whether the value actually
// reaches `bundle install`, or whether it stays out of the image
// afterwards, and both of those are the whole point: a mount that
// silently hands the step an empty file looks identical in a substring
// assertion, and so does a credential baked into a layer.
//
// So this file runs both halves for real:
//
//   - **Fabrica's own machine image build.** The `--secret` flags and
//     the environment come from `machineImageBuild` itself, and the
//     mount line from the same writer `fabrica register` uses - then the
//     image is searched for the value, in its history, in every layer's
//     bytes, and in its own configuration.
//   - **The real pinned Inspector.** Its check box is built from a terms
//     folder that mounts the secret, the check reports what the build
//     step saw, and Inspector's own report and everything it saves are
//     searched for the value.
//
// THREE THINGS TO KNOW BEFORE CHANGING ANYTHING HERE:
//
//   - **It skips only when Docker is absent**, exactly like
//     `inspector-e2e.test.ts`: anything else - no `inspector` on PATH, a
//     failed build, a red check - FAILS, naming what happened.
//   - **The Inspector half is expected to FAIL until inspector#86 is
//     merged and `.github/workflows/docker-tests.yml`'s pin moves to its
//     merge commit.** `buildSecrets` is a key the pinned Inspector does
//     not know: it reads past it, passes no `--secret`, and the mount
//     hands the step an empty file. That failure is the honest signal
//     that the other half of the pair has not landed, and it is what
//     moving the pin turns green. Nothing here works around it.
//   - **The fake value is a fake.** It never leaves this file, and the
//     searches below are for exactly it, so a test that found it would
//     be reporting a real leak path and not a real credential.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machineImageBuild, machineImageForProject } from "../projectimage/index.ts";
import { brainEnvPath } from "../brain/index.ts";
import { INSPECTOR_CONFIG } from "./origin.ts";
import { DOCKERFILE_INSPECTOR, secretMountFlags, secretReadPrefix } from "./dockerfile.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { FIXTURE_IMAGE } from "./helpers/rails-app-fixture.ts";
import { PAID_SOURCE_VARIABLE } from "./helpers/rails-fixture.ts";

/** The one condition this file skips on - see the header. */
function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * A value that is a fake, chosen so a search for it cannot match
 * anything else: it is this string and nothing in Docker, Inspector or
 * Fabrica produces it on its own.
 */
const FAKE_VALUE = "fabrica-e2e-7f3c91a4-not-a-real-credential";

/** What the build step writes into the image about what it saw - the
 * value's length, never the value (inspector#86's own suggestion for
 * the same test on its side). An image that carried the value itself is
 * exactly what the searches below are looking for. */
const WITNESS = "/fabrica-secret-witness";

function dir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `fabrica-${prefix}-`));
}

function docker(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

/**
 * The install step as `fabrica register` writes it, over a base image
 * small enough to search layer by layer - the same flags and the same
 * `cat` of `/run/secrets/<name>`, with the install command replaced by
 * one that records what the step was handed.
 *
 * `bundle install` is not the subject here and could not be: proving a
 * paid gem source really authenticated would need a real paid gem
 * source. What is under test is whether the value arrives at the step
 * at all, and whether it stays out of the image - and for both of those
 * the command after the mount is interchangeable.
 */
function probeDockerfile(from: string, names: readonly string[]): string {
  const witness = `printf '%s' "\${#${names[0]}}" > ${WITNESS}`;
  return `FROM ${from}\nRUN ${secretMountFlags(names)}${secretReadPrefix(names)}sh -c '${witness}'\n`;
}

// --------------------------------- Fabrica's own machine image build

test("a build secret reaches Fabrica's own image build, and is in no layer of what it builds", (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");

  // A project shaped the way `fabrica register` leaves one: a
  // `Dockerfile.inspector` whose install step mounts the credential, and
  // an `.inspector.json` listing its name.
  const project = dir("secret-project");
  writeFileSync(join(project, DOCKERFILE_INSPECTOR), probeDockerfile("alpine:3.20", [PAID_SOURCE_VARIABLE]));
  writeFileSync(
    join(project, INSPECTOR_CONFIG),
    `${JSON.stringify({ check: "./check.sh", buildSecrets: [PAID_SOURCE_VARIABLE] }, null, 2)}\n`
  );
  const recordHome = dir("secret-home");
  writeFileSync(join(recordHome, "projects.toml"), `[projects.app]\npath = "${project}"\n`);
  const brainEnv = brainEnvPath(recordHome);
  writeFileSync(brainEnv, `${PAID_SOURCE_VARIABLE}=${FAKE_VALUE}\n`);
  chmodSync(brainEnv, 0o600);

  // The real decision and the real argv: which flags, and what is in
  // the build's environment, are `machineImageBuild`'s own answers.
  const command = machineImageBuild(recordHome, machineImageForProject(recordHome, project));
  const secretFlags = command.args.flatMap((arg, at) =>
    arg === "--secret" ? ["--secret", command.args[at + 1]] : []
  );
  assert.deepEqual(secretFlags, ["--secret", `id=${PAID_SOURCE_VARIABLE},env=${PAID_SOURCE_VARIABLE}`]);
  assert.deepEqual(command.env, { [PAID_SOURCE_VARIABLE]: FAKE_VALUE });

  // Built from the project's own file rather than the generated one:
  // Fabrica's layer on top installs a Node and the worker CLI, which is
  // minutes and a network and is proved by a real build of its own
  // elsewhere (src/brain/adapters/machine-image-build.test.ts). What is
  // under test here is the secret, and these are the exact flags and
  // the exact environment the generated build gets.
  const image = "fabrica-build-secret-probe:latest";
  const built = docker([
    "build",
    ...secretFlags,
    "-t",
    image,
    "-f",
    join(project, DOCKERFILE_INSPECTOR),
    project,
  ]);
  t.after(() => docker(["image", "rm", "-f", image]));
  assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);

  // The step saw the real value: the length it recorded is the fake
  // value's own, which an empty or missing mount could not produce.
  const witness = docker(["run", "--rm", image, "cat", WITNESS]);
  assert.equal(witness.status, 0, `${witness.stdout}\n${witness.stderr}`);
  assert.equal(witness.stdout.trim(), String(FAKE_VALUE.length), "the mounted secret was not what the build was given");

  // ...and the value itself is nowhere in the image. Three places,
  // because a credential has turned up in each of them in the wild: the
  // build history (a `--build-arg` would be there), the image's own
  // configuration (an ENV would be there), and the layers themselves (a
  // file written by the step would be there).
  const history = docker(["history", "--no-trunc", image]);
  assert.equal(history.status, 0, history.stderr);
  assert.ok(!history.stdout.includes(FAKE_VALUE), `the value is in docker history:\n${history.stdout}`);

  const inspected = docker(["image", "inspect", image]);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.ok(!inspected.stdout.includes(FAKE_VALUE), `the value is in the image's own configuration`);

  const tar = join(dir("secret-layers"), "image.tar");
  const saved = docker(["save", "-o", tar, image]);
  assert.equal(saved.status, 0, saved.stderr);
  assert.ok(statSync(tar).size > 0, "docker save wrote nothing to search");
  assert.ok(
    !readFileSync(tar).includes(FAKE_VALUE),
    `the value is somewhere in a layer of ${image} - a mounted secret must never be written into one`
  );

  // And nothing Fabrica itself wrote while preparing that build carries
  // it either - the generated Dockerfile among them.
  for (const path of filesUnder(recordHome)) {
    if (path === brainEnv) continue; // the one file the value belongs in
    assert.ok(!readFileSync(path, "utf8").includes(FAKE_VALUE), `${path} carries the value`);
  }
});

// ------------------------------------------ the real pinned Inspector

test("the real Inspector passes a listed build secret to its check-image build, and keeps it out of its report", (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");

  const repo = makeFixtureRepo("exit 0", { inspector: false });
  const terms = dir("secret-terms");
  // Written by hand, like `inspector-e2e.test.ts`'s own box probe: this
  // is a question about what Inspector does with the key, and the check
  // it runs has to report rather than pass.
  writeFileSync(
    join(terms, INSPECTOR_CONFIG),
    `${JSON.stringify(
      { check: "sh /terms/probe.sh", buildSecrets: [PAID_SOURCE_VARIABLE] },
      null,
      2
    )}\n`
  );
  writeFileSync(join(terms, DOCKERFILE_INSPECTOR), probeDockerfile(FIXTURE_IMAGE, [PAID_SOURCE_VARIABLE]));
  // The check reads what the *build* step recorded, so the length
  // travels out through Inspector's own report - the only channel this
  // test has into the box.
  writeFileSync(
    join(terms, "probe.sh"),
    `#!/bin/sh\nprintf 'secret length seen by the build step: %s\\n' "$(cat ${WITNESS})"\n`
  );

  const run = spawnSync("inspector", ["-repo", repo, "-branch", "fabrica/build-secret-e2e", "-terms", terms], {
    encoding: "utf8",
    // Inspector reads a listed build secret out of its own environment,
    // which is exactly what Fabrica's own handoff sets for it
    // (src/inspector/run.ts). Nothing else of this machine's: no
    // GITHUB_TOKEN to publish with, so it refuses after the check has
    // already run and been reported.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      [PAID_SOURCE_VARIABLE]: FAKE_VALUE,
    },
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

  // The expected failure until inspector#86 lands: the pinned Inspector
  // reads past `buildSecrets`, so nothing is passed, the mount is empty
  // and the length is 0.
  assert.equal(report.outcome, "green", detail);
  assert.match(
    report.output ?? "",
    new RegExp(`secret length seen by the build step: ${FAKE_VALUE.length}\\b`),
    `the check image's build step was not handed the value - the usual cause is a pinned Inspector that does ` +
      `not know the buildSecrets key yet (inspector#86):\n${detail}`
  );

  // And nothing Inspector wrote carries the value: not its report, not
  // the build log it saves beside it.
  for (const path of filesUnder(join(repo, ".inspector"))) {
    assert.ok(!readFileSync(path).includes(FAKE_VALUE), `${path} carries the value`);
  }
});

/** Every file under a directory, recursively, as absolute paths. */
function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at)) {
      const path = join(at, entry);
      if (statSync(path).isDirectory()) walk(path);
      else found.push(path);
    }
  };
  walk(root);
  return found;
}
