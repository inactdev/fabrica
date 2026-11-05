// An image build's inputs from outside the Dockerfile - a build secret
// and the repository itself - end to end, against real Docker and the
// real installed Inspector (issues #342 and #344).
//
// Everything else about either one is asserted on the *text* Fabrica
// writes - the config's key, the Dockerfile's mount line, the `docker
// build` argv. None of that can tell you whether the value actually
// reaches `bundle install`, whether the repository's own files reach a
// `COPY --from=repo`, or whether the credential stays out of the image
// afterwards, and all three are the whole point: a mount that silently
// hands the step an empty file looks identical in a substring
// assertion, and so does a credential baked into a layer.
//
// So this file runs all three of them for real:
//
//   - **Fabrica's own machine image build.** The `--secret` flags and
//     the environment come from `machineImageBuild` itself, and the
//     mount line from the same writer `fabrica register` uses - then the
//     image is searched for the value, in its history, in every layer's
//     bytes, and in its own configuration.
//   - **The whole of that build, for a work-mode project, through the
//     runner a task start really uses** (`ensureMachineImage` →
//     `runImageCommand`): the generated Dockerfile, Fabrica's own layer
//     included, built from a terms folder whose file both mounts the
//     credential and copies the repository's manifest out of the `repo`
//     build context. Nothing in it is a hand-written `docker` call, so
//     a flag Fabrica fails to pass fails this test.
//   - **The real pinned Inspector.** Its check box is built from a terms
//     folder that mounts the secret, the check reports what the build
//     step saw, and Inspector's own report and everything it saves are
//     searched for the value.
//
// Why a test about `src/projectimage/`'s own argv lives under
// `src/register/`: `.github/workflows/docker-tests.yml`'s path gate
// (`DOCKER_PATHS`) names `src/register/*` and does not name
// `src/projectimage/*`, so a pull request touching only that directory
// takes the fast path - and a Docker test placed there would skip
// locally and never run on the merge path either. See
// `notes/20261105-start-a-task-on-it-yg.md`.
//
// THREE THINGS TO KNOW BEFORE CHANGING ANYTHING HERE:
//
//   - **It skips only when Docker is absent**, exactly like
//     `inspector-e2e.test.ts`: anything else - no `inspector` on PATH, a
//     failed build, a red check - FAILS, naming what happened.
//   - **The Inspector half needs an Inspector that knows the
//     `buildSecrets` key**, which is the commit
//     `.github/workflows/docker-tests.yml` pins. An older Inspector
//     reads past the key, passes no `--secret`, and the mount hands the
//     step an empty file - a failure here naming a length of 0 is that,
//     and the fix is the pin, never a workaround in this file.
//   - **The fake value is a fake.** It never leaves this file, and the
//     searches below are for exactly it, so a test that found it would
//     be reporting a real leak path and not a real credential.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machineImageBuild, machineImageForProject } from "../projectimage/index.ts";
import { brainEnvPath } from "../brain/index.ts";
import type { ImageCommand } from "../brain/index.ts";
// The runner a task start and `fabrica doctor --fix` really put a
// project's machine image on this machine with - driven here rather
// than imitated, so this test is about what Fabrica does and not about
// what this file remembers Fabrica doing.
import { ensureMachineImage } from "../cli/machine-image.ts";
import { REPO_BUILD_CONTEXT } from "../inspector/index.ts";
import { INSPECTOR_CONFIG } from "./origin.ts";
import { DEPS_DIR, DOCKERFILE_INSPECTOR, secretMountFlags, secretReadPrefix } from "./dockerfile.ts";
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

/**
 * One `docker` command.
 *
 * `env` is for a build that mounts a secret: `--secret id=NAME,env=NAME`
 * reads the value out of the `docker` process's own environment, so a
 * build run without it mounts an empty file and the step sees nothing.
 * It is spread over `process.env` rather than replacing it, exactly the
 * way `src/cli/image-repair.ts` runs the real build - docker needs
 * `PATH`, `HOME` and `DOCKER_HOST` from this machine to work at all.
 */
function docker(
  args: string[],
  env?: Record<string, string>
): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  });
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
  const built = docker(
    ["build", ...secretFlags, "-t", image, "-f", join(project, DOCKERFILE_INSPECTOR), project],
    // The environment `machineImageBuild` asked for, on top of this
    // machine's own - the half of its answer that carries the value.
    // Without it the mount is there and empty, and the witness below
    // records 0.
    command.env
  );
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

// ---------- the whole build, through the runner a task start uses
//
// Issue #344. The test above builds the project's own half of the
// Dockerfile with a `docker` command this file assembles, which cannot
// catch a flag Fabrica never passes - and `--build-context repo=` was
// exactly that: a work-mode project's `Dockerfile.inspector` says
// `COPY --from=repo`, Fabrica's build named no such context, and Docker
// read `repo` as an image, so `fabrica update` and `fabrica doctor
// --fix` failed on every such project with "failed to resolve source
// metadata for docker.io/library/repo:latest".
//
// So this one hands nothing to docker itself. `ensureMachineImage` is
// what a task start and `fabrica doctor --fix` call; it asks
// `machineImageBuild` for the command and `runImageCommand` runs it.

/** Files the repository carries and the terms folder does not - what a
 * real project's install step copies in, and the whole reason the
 * named context exists. */
const REPO_FILES = ["Gemfile", "Gemfile.lock"] as const;

/** Content unique to each copied file, so "the file arrived" cannot be
 * confused with "a file of that name was already in the image". */
function repoFileContent(name: string): string {
  return `# ${name} from the repository under check, not from the terms folder\n`;
}

/** How long a real build of a generated machine Dockerfile may take:
 * it installs the Node Fabrica pins and the worker CLI on top of the
 * project's own image, which is minutes on any connection - the same
 * ceiling src/brain/adapters/machine-image-build.test.ts allows its own
 * real builds. */
const BUILD_TIMEOUT_MS = 45 * 60 * 1000;

/**
 * A terms folder's `Dockerfile.inspector`, in the shape `fabrica
 * register` writes for a project whose terms live outside its
 * repository: every `COPY` reads the named `repo` context, since the
 * build's own context holds none of those files, and the install step
 * mounts the credential.
 *
 * `FIXTURE_IMAGE` is the base because Fabrica's own layer is appended to
 * this file and really installed: that needs bash, git, a downloader, a
 * checksum tool and a libc nodejs.org publishes a build for, which the
 * official Ruby image (Debian, glibc, buildpack-deps) carries and the
 * `alpine:3.20` the test above builds on does not.
 */
function termsDockerfile(names: readonly string[]): string {
  const witness = `printf '%s' "\${#${names[0]}}" > ${WITNESS}`;
  return [
    `FROM ${FIXTURE_IMAGE}`,
    `RUN mkdir -p ${DEPS_DIR}`,
    `COPY --from=${REPO_BUILD_CONTEXT} ${REPO_FILES.join(" ")} ${DEPS_DIR}/`,
    `RUN ${secretMountFlags(names)}${secretReadPrefix(names)}sh -c '${witness}'`,
    "",
  ].join("\n");
}

/** `docker run` of one command in a built image. `--entrypoint`
 * because a project's own Dockerfile may set one, exactly as
 * `installedCliVersionIn` does. */
function inImage(image: string, argv: string[]): { status: number | null; stdout: string; stderr: string } {
  return docker(["run", "--rm", "--entrypoint", argv[0], image, ...argv.slice(1)]);
}

/**
 * Whether `value` is anywhere in the bytes of an image's layers.
 *
 * Streamed, never written to disk or held whole in memory: this image
 * carries a Ruby, a Node and the worker CLI, so `docker save` is
 * hundreds of megabytes - where the alpine-based test above can afford
 * one `readFileSync`. `tail` keeps the last `value.length - 1` bytes of
 * each chunk, so a match straddling a chunk boundary is still found,
 * and `latin1` is a byte-for-byte reading of the stream rather than a
 * decoding of it.
 */
async function imageLayersCarry(image: string, value: string): Promise<boolean> {
  const child = spawn("docker", ["save", image], { stdio: ["ignore", "pipe", "inherit"] });
  let found = false;
  let tail = "";
  child.stdout.on("data", (chunk: Buffer) => {
    const text = tail + chunk.toString("latin1");
    if (text.includes(value)) found = true;
    tail = text.slice(-(value.length - 1));
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0, `docker save ${image} exited ${code}, so its layers were never searched`);
  return found;
}

test(
  "a work-mode project's machine image builds through the real runner, with the repository on the repo context and the credential mounted",
  { timeout: BUILD_TIMEOUT_MS },
  async (t) => {
    if (!dockerAvailable()) return t.skip("Docker is not available on this machine");

    // A registered work-mode project: the repository carries the files
    // the install step needs and nothing of Fabrica's, and the terms
    // folder beside it carries the two files Fabrica and Inspector read.
    const repo = makeFixtureRepo("exit 0", { inspector: false, origin: false });
    for (const name of REPO_FILES) writeFileSync(join(repo, name), repoFileContent(name));
    const terms = dir("repo-context-terms");
    writeFileSync(
      join(terms, INSPECTOR_CONFIG),
      `${JSON.stringify({ check: "./check.sh", buildSecrets: [PAID_SOURCE_VARIABLE] }, null, 2)}\n`
    );
    writeFileSync(join(terms, DOCKERFILE_INSPECTOR), termsDockerfile([PAID_SOURCE_VARIABLE]));
    const recordHome = dir("repo-context-home");
    writeFileSync(join(recordHome, "projects.toml"), `[projects.dayjob]\npath = "${repo}"\nterms = "${terms}"\n`);
    const brainEnv = brainEnvPath(recordHome);
    writeFileSync(brainEnv, `${PAID_SOURCE_VARIABLE}=${FAKE_VALUE}\n`);
    chmodSync(brainEnv, 0o600);

    // The file being layered is the terms folder's, not the
    // repository's - which carries none. Compared by contents rather
    // than by path: projects.toml's loader does not realpath a terms
    // folder, so on macOS the registered path and `realpathSync`'s
    // answer for it differ by /var -> /private/var.
    const machine = machineImageForProject(recordHome, repo);
    assert.equal(
      readFileSync(machine.inspectorDockerfile ?? "", "utf8"),
      termsDockerfile([PAID_SOURCE_VARIABLE]),
      "the terms folder's own Dockerfile.inspector has to be the one this image is built from"
    );
    assert.equal(machine.context, realpathSync(repo), "the build context is the repository");
    t.after(() => docker(["image", "rm", "-f", machine.image]));

    // The real thing, start to finish: no docker command of this file's
    // own anywhere in it. `onBuilding` is handed the argv that is about
    // to run, which is the one place a test can read what Fabrica
    // actually passes without assembling it again.
    const log: string[] = [];
    let ran: ImageCommand | undefined;
    const result = await ensureMachineImage(recordHome, machine, {
      onBuilding: (_machine, command) => {
        ran = command;
      },
      onOutput: (line) => log.push(line),
    });
    assert.ok(result.ok, `the build failed: ${result.detail}\n${log.join("\n")}`);
    assert.ok(result.built, "the image was not there, so it had to have been built");
    assert.ok(ran !== undefined, "nothing reported a build, so nothing ran");
    assert.ok(
      ran.args.includes(`${REPO_BUILD_CONTEXT}=${machine.project}`),
      `the repository has to ride on the ${REPO_BUILD_CONTEXT} context: ${ran.args.join(" ")}`
    );

    // What the build really received. The repository's own files are in
    // the image, with the repository's own contents - which only a build
    // that resolved `--from=repo` to the repository could produce.
    for (const name of REPO_FILES) {
      const copied = inImage(machine.image, ["cat", `${DEPS_DIR}/${name}`]);
      assert.equal(copied.status, 0, `${DEPS_DIR}/${name} is not in the image:\n${copied.stderr}`);
      assert.equal(copied.stdout, repoFileContent(name));
    }

    // ...and the credential's own length, which an empty or missing
    // mount could not produce.
    const witness = inImage(machine.image, ["cat", WITNESS]);
    assert.equal(witness.status, 0, `${witness.stdout}\n${witness.stderr}`);
    assert.equal(witness.stdout.trim(), String(FAKE_VALUE.length), "the mounted secret was not what the build was given");

    // The value itself is nowhere: not in the build's own output (which
    // the real runner streams to whoever is waiting), not in the image's
    // history or configuration, and not in a layer.
    assert.ok(!log.join("\n").includes(FAKE_VALUE), "the build's own output carries the value");
    const history = docker(["history", "--no-trunc", machine.image]);
    assert.equal(history.status, 0, history.stderr);
    assert.ok(!history.stdout.includes(FAKE_VALUE), `the value is in docker history:\n${history.stdout}`);
    const inspected = docker(["image", "inspect", machine.image]);
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.ok(!inspected.stdout.includes(FAKE_VALUE), "the value is in the image's own configuration");
    assert.equal(
      await imageLayersCarry(machine.image, FAKE_VALUE),
      false,
      `the value is somewhere in a layer of ${machine.image} - a mounted secret must never be written into one`
    );

    // Nor in anything Fabrica wrote while preparing the build - the
    // generated Dockerfile among them.
    for (const path of filesUnder(recordHome)) {
      if (path === brainEnv) continue; // the one file the value belongs in
      assert.ok(!readFileSync(path, "utf8").includes(FAKE_VALUE), `${path} carries the value`);
    }
  }
);

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

  // Green, and the length the build step really saw - which only an
  // Inspector that passed the secret to its own build could produce.
  assert.equal(report.outcome, "green", detail);
  assert.match(
    report.output ?? "",
    new RegExp(`secret length seen by the build step: ${FAKE_VALUE.length}\\b`),
    `the check image's build step was not handed the value - the usual cause is an Inspector older than ` +
      `inspector#87, which does not know the buildSecrets key:\n${detail}`
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
