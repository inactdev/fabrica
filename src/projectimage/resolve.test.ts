import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildSecretsError } from "../buildsecrets/index.ts";
import { loadConfig } from "../config/index.ts";
import { appendEvent } from "../record/index.ts";
import { DEFAULT_MACHINE_IMAGE } from "../brain/index.ts";
import { REPO_BUILD_CONTEXT } from "../inspector/index.ts";
import {
  isLayered,
  machineDockerfileFor,
  machineDockerfilePath,
  machineImageBuild,
  machineImageFor,
  machineImageForProject,
  machineImageForTask,
  machineImageLabel,
  machineImageStamp,
  machineImageStatus,
  machineImageTag,
  MACHINE_IMAGE_PREFIX,
} from "./resolve.ts";
import type { FabricaConfig } from "../config/index.ts";

const DOCKERFILE = "FROM ruby:3.4\nRUN bundle install\n";

/** What `ruby:3.4` - the fixture base above - says it runs as in its
 * own configuration: nothing, which means root. Handed in by every test
 * here rather than read off a real daemon; that probe has its own cases
 * in src/brain/adapters/machine-layer.test.ts, and what a real base
 * image really carries is proved by a real build in
 * src/brain/adapters/machine-image-build.test.ts. */
const BASE_USER = () => "";

function recordHomeWith(projectsToml = ""): string {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-image-home-"));
  if (projectsToml !== "") writeFileSync(join(recordHome, "projects.toml"), projectsToml);
  return recordHome;
}

/** A project folder, with or without a Dockerfile.inspector in it. */
function projectDir(opts: { dockerfile?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-image-project-"));
  if (opts.dockerfile !== undefined) writeFileSync(join(dir, "Dockerfile.inspector"), opts.dockerfile);
  return dir;
}

function configOf(projectsToml: string): FabricaConfig {
  return loadConfig(recordHomeWith(projectsToml));
}

test("a project committing a Dockerfile.inspector gets an image of its own, layered on it", () => {
  const project = projectDir({ dockerfile: DOCKERFILE });
  const machine = machineImageFor(configOf(`[projects.app]\npath = "${project}"\n`), project);

  assert.ok(isLayered(machine));
  assert.equal(machine.inspectorDockerfile, join(machine.project, "Dockerfile.inspector"));
  assert.ok(machine.image.startsWith(MACHINE_IMAGE_PREFIX), `expected a per-project tag, got ${machine.image}`);
  assert.notEqual(machine.image, DEFAULT_MACHINE_IMAGE);
  // The repository, not the folder the Dockerfile sits in: the COPY
  // lines in the shape `fabrica register` writes name paths in the repo.
  assert.equal(machine.context, machine.project);
});

test("a project committing none keeps the shared image, with nothing per-project to build", () => {
  const project = projectDir();
  const machine = machineImageFor(configOf(`[projects.app]\npath = "${project}"\n`), project);

  assert.equal(isLayered(machine), false);
  assert.equal(machine.image, DEFAULT_MACHINE_IMAGE);
  assert.equal(machine.inspectorDockerfile, null);
});

test("a work-mode project is asked about its terms folder, never its repository", () => {
  // Issue #316: the repository is one nothing of ours may be added to,
  // so it carries no Dockerfile.inspector by design. Reading it there
  // would silently put every such project back on the shared image.
  const project = projectDir();
  const terms = projectDir({ dockerfile: DOCKERFILE });
  const machine = machineImageFor(configOf(`[projects.dayjob]\npath = "${project}"\nterms = "${terms}"\n`), project);

  assert.ok(isLayered(machine));
  assert.equal(readFileSync(machine.inspectorDockerfile ?? "", "utf8"), DOCKERFILE);
  assert.equal(machine.context, machine.project, "the build context is still the repository");
});

test("an unregistered project still gets the image its own repository asks for", () => {
  // A contract fixture, or a path `fabrica do` was pointed at before it
  // was registered: no entry to read work mode from, and the
  // repository's own file is still the answer.
  const project = projectDir({ dockerfile: DOCKERFILE });
  const recordHome = recordHomeWith();

  assert.ok(isLayered(machineImageForProject(recordHome, project)));
});

test("two projects whose folders are named the same get two different images", () => {
  const parentA = mkdtempSync(join(tmpdir(), "fabrica-image-a-"));
  const parentB = mkdtempSync(join(tmpdir(), "fabrica-image-b-"));
  mkdirSync(join(parentA, "api"));
  mkdirSync(join(parentB, "api"));

  const a = machineImageTag(join(parentA, "api"));
  const b = machineImageTag(join(parentB, "api"));

  assert.notEqual(a, b, "the path, not the folder name, is what identifies a project");
  assert.match(a, /^fabrica-machine-api-[0-9a-f]{12}:latest$/);
  assert.equal(machineImageTag(join(parentA, "api")), a, "the same project must always be the same image");
});

test("a tag is a legal docker image reference even for an awkward folder name", () => {
  const parent = mkdtempSync(join(tmpdir(), "fabrica-image-odd-"));
  const odd = join(parent, "My Project (v2)!");
  mkdirSync(odd);

  // Lowercase, and only the separators a repository name may carry.
  assert.match(machineImageTag(odd), /^[a-z0-9]+(?:[._-][a-z0-9]+)*:latest$/);
});

test("the generated Dockerfile is the project's own file plus Fabrica's layer", () => {
  const project = projectDir({ dockerfile: DOCKERFILE });
  const text = machineDockerfileFor(machineImageForProject(recordHomeWith(), project), BASE_USER);

  assert.ok(text.includes(DOCKERFILE.trimEnd()), "the project's own file has to be in there verbatim");
  assert.match(text, /nodejs\.org/, "and Fabrica's own layer on top of it");
});

test("there is no generated Dockerfile for a project on the shared image", () => {
  const machine = machineImageForProject(recordHomeWith(), projectDir());
  assert.throws(() => machineDockerfileFor(machine, BASE_USER), /has no Dockerfile\.inspector/);
});

test("the stamp moves when the project's own file changes, and when the layer does", () => {
  const project = projectDir({ dockerfile: DOCKERFILE });
  const machine = machineImageForProject(recordHomeWith(), project);
  const before = machineImageStamp(machineDockerfileFor(machine, BASE_USER));

  writeFileSync(join(project, "Dockerfile.inspector"), `${DOCKERFILE}RUN apt-get install -y imagemagick\n`);
  const after = machineImageStamp(machineDockerfileFor(machine, BASE_USER));

  assert.notEqual(before, after);
  // The layer carries both version pins, so a bump moves the same hash -
  // which is the whole of "rebuilt when either input changes".
  assert.notEqual(machineImageStamp("FROM ruby:3.4\n"), before);
  assert.equal(machineImageStamp(machineDockerfileFor(machine, BASE_USER)), after, "the same two inputs must hash the same");
});

test("the build command writes the generated Dockerfile and passes the stamp as a build arg", () => {
  const project = projectDir({ dockerfile: DOCKERFILE });
  const recordHome = recordHomeWith();
  const machine = machineImageForProject(recordHome, project);

  const command = machineImageBuild(recordHome, machine, BASE_USER);
  const path = machineDockerfilePath(recordHome, machine);

  assert.equal(command.command, "docker");
  assert.equal(command.image, machine.image);
  assert.deepEqual(command.args, [
    "build",
    "--build-arg",
    `FABRICA_IMAGE_STAMP=${machineImageStamp(readFileSync(path, "utf8"))}`,
    "--build-context",
    `repo=${machine.context}`,
    "-t",
    machine.image,
    "-f",
    path,
    machine.context,
  ]);
  assert.equal(readFileSync(path, "utf8"), machineDockerfileFor(machine, BASE_USER));
  assert.match(command.shell, /^docker build /);
});

// ------------------------------- the repo build context (issue #344)

test("the repository rides on the repo build context for a project whose terms are in a folder", () => {
  // The fault this closes: a terms folder holds no manifest and no
  // lockfile, so the file there says `COPY --from=repo ...` - and with
  // no `--build-context` naming it, Docker read `repo` as an image and
  // every such build failed on docker.io/library/repo:latest.
  const project = projectDir();
  const terms = projectDir({ dockerfile: `FROM ruby:3.4\nCOPY --from=repo Gemfile /deps/\n` });
  const recordHome = recordHomeWith(`[projects.dayjob]\npath = "${project}"\nterms = "${terms}"\n`);
  const machine = machineImageForProject(recordHome, project);

  const command = machineImageBuild(recordHome, machine, BASE_USER);

  const at = command.args.indexOf("--build-context");
  assert.notEqual(at, -1, `no named build context at all: ${command.args.join(" ")}`);
  // The repository, by name - never the terms folder the Dockerfile
  // itself sits in, which is exactly what has none of those files.
  assert.equal(command.args[at + 1], `${REPO_BUILD_CONTEXT}=${machine.project}`);
  assert.notEqual(machine.project, realpathSync(terms));
  assert.ok(command.shell.includes(`--build-context ${REPO_BUILD_CONTEXT}=${machine.project}`), command.shell);
});

test("a repository-route project's build carries the same repo build context", () => {
  // Passed for every project, not only the terms-folder one - the same
  // rule Inspector states for its own builds, so one Dockerfile works
  // in both. Nothing `fabrica register` writes for a repository-route
  // project reads it; a project that later moves its terms out needs no
  // second decision.
  const project = projectDir({ dockerfile: DOCKERFILE });
  const recordHome = recordHomeWith(`[projects.app]\npath = "${project}"\n`);
  const machine = machineImageForProject(recordHome, project);

  const command = machineImageBuild(recordHome, machine, BASE_USER);

  assert.ok(
    command.args.includes(`${REPO_BUILD_CONTEXT}=${machine.project}`),
    `expected the repository under the ${REPO_BUILD_CONTEXT} context: ${command.args.join(" ")}`
  );
  // And it is the same folder as the main context, which is what makes
  // it a no-op here rather than a second source of files.
  assert.equal(command.args[command.args.length - 1], machine.context);
});

test("nothing is written until a build is actually asked for", () => {
  // Plain `fabrica doctor` is read-only (Client ruling 2026-10-30), and
  // it asks every question below without ever asking for a build.
  const project = projectDir({ dockerfile: DOCKERFILE });
  const recordHome = recordHomeWith(`[projects.app]\npath = "${project}"\n`);
  const machine = machineImageForProject(recordHome, project);

  machineImageStatus("project app image", machine, { stamp: () => null, baseUser: BASE_USER });
  machineDockerfileFor(machine, BASE_USER);

  assert.equal(existsSync(join(recordHome, "images")), false);
});

test("a task's own rounds resume in the image its project asks for", () => {
  const project = projectDir({ dockerfile: DOCKERFILE });
  const recordHome = recordHomeWith(`[projects.app]\npath = "${project}"\n`);
  appendEvent(recordHome, { taskId: "task-1", name: "task-received", details: {} });
  appendEvent(recordHome, { taskId: "task-1", name: "work-started", details: { project } });

  assert.equal(machineImageForTask(recordHome, "task-1")?.image, machineImageTag(project));
});

test("a task whose record names no project has no image of its own", () => {
  // A task that died in the clarifying step, before any round: there is
  // nothing to resolve, and the adapter's own default stands.
  const recordHome = recordHomeWith();
  appendEvent(recordHome, { taskId: "task-1", name: "task-received", details: {} });

  assert.equal(machineImageForTask(recordHome, "task-1"), null);
});

test("the status line names the shared image, and asks for no build, for an unlayered project", () => {
  const machine = machineImageForProject(recordHomeWith(), projectDir());
  const check = machineImageStatus(machineImageLabel("app"), machine, { stamp: () => "unused", baseUser: BASE_USER });

  assert.equal(check.ok, true);
  assert.equal(check.needsBuild, false);
  assert.equal(check.label, "project app image");
  assert.match(check.detail, /the shared image, since this project commits no Dockerfile\.inspector/);
});

test("a missing, unstamped or stale image is a FAIL that asks for a build", () => {
  const project = projectDir({ dockerfile: DOCKERFILE });
  const machine = machineImageForProject(recordHomeWith(), project);
  const label = machineImageLabel("app");

  for (const [stamp, expected] of [
    [null, /not built/],
    ["", /carries no Dockerfile stamp/],
    ["a-stamp-from-some-older-build", /out of date/],
  ] as [string | null, RegExp][]) {
    const check = machineImageStatus(label, machine, { stamp: () => stamp, baseUser: BASE_USER });
    assert.equal(check.ok, false, `expected a FAIL for stamp ${JSON.stringify(stamp)}`);
    assert.equal(check.needsBuild, true);
    assert.match(check.detail, expected);
    assert.match(check.fix ?? "", /fabrica doctor --fix/);
  }
});

test("a current image passes, naming the worker CLI version inside it", () => {
  const project = projectDir({ dockerfile: DOCKERFILE });
  const machine = machineImageForProject(recordHomeWith(), project);
  const current = machineImageStamp(machineDockerfileFor(machine, BASE_USER));

  const check = machineImageStatus(machineImageLabel("app"), machine, {
    stamp: () => current,
    installedCli: () => "2.1.222",
    pinnedCli: () => "2.1.222",
    baseUser: BASE_USER,
  });

  assert.equal(check.ok, true);
  assert.equal(check.needsBuild, false);
  assert.match(check.detail, /built and current, worker CLI 2\.1\.222, the pinned version/);
});

test("the worker CLI version check applies to a per-project image too, and a rebuild is not its fix", () => {
  // The issue's own clarification. `needsBuild` false for the same
  // reason the shared image's "worker CLI" line is not a repair trigger:
  // the image was built from this very Dockerfile and still has another
  // version inside, so a layer-cached rebuild cannot change it.
  const project = projectDir({ dockerfile: DOCKERFILE });
  const machine = machineImageForProject(recordHomeWith(), project);
  const current = machineImageStamp(machineDockerfileFor(machine, BASE_USER));

  const check = machineImageStatus(machineImageLabel("app"), machine, {
    stamp: () => current,
    installedCli: () => "2.0.1",
    pinnedCli: () => "2.1.222",
    baseUser: BASE_USER,
  });

  assert.equal(check.ok, false);
  assert.equal(check.needsBuild, false);
  assert.match(check.detail, /it has worker CLI 2\.0\.1 installed where 2\.1\.222 is pinned/);
});

test("an image whose CLI version cannot be read is reported, never failed on", () => {
  // The "project <name> image" line above already owns a missing image;
  // saying the same thing twice in different words helps nobody.
  const project = projectDir({ dockerfile: DOCKERFILE });
  const machine = machineImageForProject(recordHomeWith(), project);
  const current = machineImageStamp(machineDockerfileFor(machine, BASE_USER));

  const check = machineImageStatus(machineImageLabel("app"), machine, {
    stamp: () => current,
    installedCli: () => null,
    pinnedCli: () => "2.1.222",
    baseUser: BASE_USER,
  });

  assert.equal(check.ok, true);
  assert.match(check.detail, /its worker CLI version could not be read/);
});

test("the base image's own user is part of the stamp, so a change to it is a rebuild", () => {
  // A project's own file need not name a user at all, and then the one
  // the generated image ends as comes from the base image itself. Which
  // makes it a third input, alongside that file and Fabrica's layer -
  // and "rebuilt when either input changes" has to cover it.
  const project = projectDir({ dockerfile: DOCKERFILE });
  const machine = machineImageForProject(recordHomeWith(), project);

  const asRoot = machineImageStamp(machineDockerfileFor(machine, BASE_USER));
  const asSomeone = machineImageStamp(machineDockerfileFor(machine, () => "someone"));

  assert.notEqual(asRoot, asSomeone);
  const check = machineImageStatus(machineImageLabel("app"), machine, {
    stamp: () => asRoot,
    baseUser: () => "someone",
  });
  assert.equal(check.ok, false);
  assert.equal(check.needsBuild, true);
  assert.match(check.detail, /out of date/);
});

test("a base image whose user cannot be read is a FAIL that says so, not a box quietly run as root", () => {
  const project = projectDir({ dockerfile: DOCKERFILE });
  const machine = machineImageForProject(recordHomeWith(), project);

  const check = machineImageStatus(machineImageLabel("app"), machine, { stamp: () => "some-stamp", baseUser: () => null });

  assert.equal(check.ok, false);
  assert.equal(check.needsBuild, false, "a build would fail on the same question");
  assert.match(check.detail, /the one ruby:3\.4 itself runs as - and that could not be read/);
});

test("a Dockerfile.inspector that disappeared is reported as that, not as a stale image", () => {
  const project = projectDir({ dockerfile: DOCKERFILE });
  const machine = machineImageForProject(recordHomeWith(), project);
  rmSync(join(project, "Dockerfile.inspector"));

  const check = machineImageStatus(machineImageLabel("app"), machine, { stamp: () => "some-stamp", baseUser: BASE_USER });

  assert.equal(check.ok, false);
  assert.equal(check.needsBuild, false, "a build would fail on the same missing file");
  assert.match(check.detail, /cannot be read/);
});

// ------------------------------------- build secrets (issue #342)

const SECRET_VAR = "BUNDLE_ENTERPRISE__CONTRIBSYS__COM";
const SECRET_VALUE = "someone:a-real-looking-password";

/** A project whose `.inspector.json` lists a build secret, beside the
 * `Dockerfile.inspector` whose install step mounts it. */
function projectNeedingASecret(): string {
  const dir = projectDir({ dockerfile: `FROM ruby:3.4\nRUN --mount=type=secret,id=${SECRET_VAR} bundle install\n` });
  writeFileSync(
    join(dir, ".inspector.json"),
    `${JSON.stringify({ check: "./check.sh", buildSecrets: [SECRET_VAR] }, null, 2)}\n`
  );
  return dir;
}

function withBrainEnv(recordHome: string, contents: string): void {
  const path = join(recordHome, "brain.env");
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

test("a project's build secrets go on the build as --secret, by name, and in its environment by value", () => {
  const project = projectNeedingASecret();
  const recordHome = recordHomeWith();
  withBrainEnv(recordHome, `${SECRET_VAR}=${SECRET_VALUE}\n`);
  const machine = machineImageForProject(recordHome, project);

  const command = machineImageBuild(recordHome, machine, BASE_USER);

  // The name is in the argv, which every process on this machine can
  // read; the value is in the environment, which they cannot.
  assert.ok(
    command.args.join(" ").includes(`--secret id=${SECRET_VAR},env=${SECRET_VAR}`),
    command.args.join(" ")
  );
  assert.deepEqual(command.env, { [SECRET_VAR]: SECRET_VALUE });
  assert.ok(!command.shell.includes(SECRET_VALUE), `the printed command must never carry a value: ${command.shell}`);
  assert.ok(!command.args.join(" ").includes(SECRET_VALUE), command.args.join(" "));
});

test("a project that needs no credential gets no --secret and no environment of its own", () => {
  const project = projectDir({ dockerfile: DOCKERFILE });
  const recordHome = recordHomeWith();
  const command = machineImageBuild(recordHome, machineImageForProject(recordHome, project), BASE_USER);

  assert.ok(!command.args.includes("--secret"), command.args.join(" "));
  assert.equal(command.env, undefined);
});

test("a build whose credential is not on this machine refuses by name, and writes nothing", () => {
  const project = projectNeedingASecret();
  const recordHome = recordHomeWith();
  const machine = machineImageForProject(recordHome, project);

  assert.throws(
    () => machineImageBuild(recordHome, machine, BASE_USER),
    (err: unknown) => {
      assert.ok(err instanceof BuildSecretsError, `a typed refusal, so callers can tell it from an unreadable file: ${err}`);
      assert.equal(err.code, "missing-build-secret");
      assert.deepEqual(err.variables, [SECRET_VAR]);
      assert.match(err.message, new RegExp(SECRET_VAR));
      return true;
    }
  );
  // Refused before anything was written: a half-prepared build leaves a
  // generated Dockerfile claiming an image that was never built.
  assert.equal(existsSync(machineDockerfilePath(recordHome, machine)), false);
});
