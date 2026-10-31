import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/index.ts";
import { appendEvent } from "../record/index.ts";
import { DEFAULT_MACHINE_IMAGE } from "../brain/index.ts";
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
  const text = machineDockerfileFor(machineImageForProject(recordHomeWith(), project));

  assert.ok(text.includes(DOCKERFILE.trimEnd()), "the project's own file has to be in there verbatim");
  assert.match(text, /nodejs\.org/, "and Fabrica's own layer on top of it");
});

test("there is no generated Dockerfile for a project on the shared image", () => {
  const machine = machineImageForProject(recordHomeWith(), projectDir());
  assert.throws(() => machineDockerfileFor(machine), /has no Dockerfile\.inspector/);
});

test("the stamp moves when the project's own file changes, and when the layer does", () => {
  const project = projectDir({ dockerfile: DOCKERFILE });
  const machine = machineImageForProject(recordHomeWith(), project);
  const before = machineImageStamp(machineDockerfileFor(machine));

  writeFileSync(join(project, "Dockerfile.inspector"), `${DOCKERFILE}RUN apt-get install -y imagemagick\n`);
  const after = machineImageStamp(machineDockerfileFor(machine));

  assert.notEqual(before, after);
  // The layer carries both version pins, so a bump moves the same hash -
  // which is the whole of "rebuilt when either input changes".
  assert.notEqual(machineImageStamp("FROM ruby:3.4\n"), before);
  assert.equal(machineImageStamp(machineDockerfileFor(machine)), after, "the same two inputs must hash the same");
});

test("the build command writes the generated Dockerfile and passes the stamp as a build arg", () => {
  const project = projectDir({ dockerfile: DOCKERFILE });
  const recordHome = recordHomeWith();
  const machine = machineImageForProject(recordHome, project);

  const command = machineImageBuild(recordHome, machine);
  const path = machineDockerfilePath(recordHome, machine);

  assert.equal(command.command, "docker");
  assert.equal(command.image, machine.image);
  assert.deepEqual(command.args, [
    "build",
    "--build-arg",
    `FABRICA_IMAGE_STAMP=${machineImageStamp(readFileSync(path, "utf8"))}`,
    "-t",
    machine.image,
    "-f",
    path,
    machine.context,
  ]);
  assert.equal(readFileSync(path, "utf8"), machineDockerfileFor(machine));
  assert.match(command.shell, /^docker build /);
});

test("nothing is written until a build is actually asked for", () => {
  // Plain `fabrica doctor` is read-only (Client ruling 2026-10-30), and
  // it asks every question below without ever asking for a build.
  const project = projectDir({ dockerfile: DOCKERFILE });
  const recordHome = recordHomeWith(`[projects.app]\npath = "${project}"\n`);
  const machine = machineImageForProject(recordHome, project);

  machineImageStatus("project app image", machine, { stamp: () => null });
  machineDockerfileFor(machine);

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
  const check = machineImageStatus(machineImageLabel("app"), machine, { stamp: () => "unused" });

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
    const check = machineImageStatus(label, machine, { stamp: () => stamp });
    assert.equal(check.ok, false, `expected a FAIL for stamp ${JSON.stringify(stamp)}`);
    assert.equal(check.needsBuild, true);
    assert.match(check.detail, expected);
    assert.match(check.fix ?? "", /fabrica doctor --fix/);
  }
});

test("a current image passes, naming the worker CLI version inside it", () => {
  const project = projectDir({ dockerfile: DOCKERFILE });
  const machine = machineImageForProject(recordHomeWith(), project);
  const current = machineImageStamp(machineDockerfileFor(machine));

  const check = machineImageStatus(machineImageLabel("app"), machine, {
    stamp: () => current,
    installedCli: () => "2.1.222",
    pinnedCli: () => "2.1.222",
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
  const current = machineImageStamp(machineDockerfileFor(machine));

  const check = machineImageStatus(machineImageLabel("app"), machine, {
    stamp: () => current,
    installedCli: () => "2.0.1",
    pinnedCli: () => "2.1.222",
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
  const current = machineImageStamp(machineDockerfileFor(machine));

  const check = machineImageStatus(machineImageLabel("app"), machine, {
    stamp: () => current,
    installedCli: () => null,
    pinnedCli: () => "2.1.222",
  });

  assert.equal(check.ok, true);
  assert.match(check.detail, /its worker CLI version could not be read/);
});

test("a Dockerfile.inspector that disappeared is reported as that, not as a stale image", () => {
  const project = projectDir({ dockerfile: DOCKERFILE });
  const machine = machineImageForProject(recordHomeWith(), project);
  rmSync(join(project, "Dockerfile.inspector"));

  const check = machineImageStatus(machineImageLabel("app"), machine, { stamp: () => "some-stamp" });

  assert.equal(check.ok, false);
  assert.equal(check.needsBuild, false, "a build would fail on the same missing file");
  assert.match(check.detail, /cannot be read/);
});
