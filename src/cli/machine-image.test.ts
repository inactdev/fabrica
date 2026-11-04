// The two moments nothing else puts a project's machine image on this
// machine: the start of a task, and `fabrica update` (issue #322's
// amendment, requirements 3 and 4).
//
// Driven against a fake build, never a real daemon: what is under test
// here is the decision and the refusal - when a build is run at all,
// what a failed one says, and that one project's failure reaches no
// other project. That the generated Dockerfile is actually buildable is
// a different question, proved by a real `docker build` in
// src/brain/adapters/machine-image-build.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machineImageForProject, machineImageStamp, machineDockerfileFor, DEFAULT_MACHINE_IMAGE } from "../index.ts";
import {
  buildRegisteredMachineImages,
  ensureMachineImage,
  machineImageRefusal,
  requireMachineImage,
  type MachineImageIo,
} from "./machine-image.ts";
import type { ImageCommand } from "./image-repair.ts";

/** A project folder with a `Dockerfile.inspector`, i.e. one that has a
 * machine image of its own. */
function layeredProject(name = "app"): string {
  const dir = mkdtempSync(join(tmpdir(), `fabrica-machine-${name}-`));
  writeFileSync(join(dir, "Dockerfile.inspector"), `FROM ruby:3.4\nRUN bundle install\n`);
  return dir;
}

/** A project folder with none, i.e. one that keeps the shared image. */
function plainProject(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-machine-plain-"));
}

function homeWith(projects: Record<string, string>): string {
  const home = mkdtempSync(join(tmpdir(), "fabrica-machine-home-"));
  writeFileSync(
    home + "/projects.toml",
    Object.entries(projects)
      .map(([name, path]) => `[projects.${name}]\npath = "${path}"\n`)
      .join("\n")
  );
  return home;
}

/** A fake build and a fake stamp probe, with a record of what was run.
 * `stamps` is the machine's own state: an image in it exists and carries
 * that stamp, and a successful build adds the stamp its own argv
 * carries - so what makes a second call skip the build is the same pin
 * `fabrica doctor` reads, not this suite agreeing with itself. */
function fakeDocker(opts: { fails?: string } = {}) {
  const stamps = new Map<string, string>();
  const built: string[] = [];
  const io: MachineImageIo = {
    stamp: (image) => stamps.get(image) ?? null,
    // `ruby:3.4` runs as root, and saying so here is what keeps this
    // suite off a real daemon: composing a generated Dockerfile has to
    // know the user its base image carries, which lives in the image
    // rather than in anybody's text.
    baseUser: () => "",
    run: async (cmd: ImageCommand) => {
      built.push(cmd.image);
      if (opts.fails !== undefined) return { ok: false, detail: opts.fails };
      const arg = cmd.args[cmd.args.indexOf("--build-arg") + 1] ?? "";
      const stamp = arg.split("=")[1] ?? "";
      assert.match(stamp, /^[0-9a-f]{64}$/, `the build has to carry the generated Dockerfile's hash: ${arg}`);
      stamps.set(cmd.image, stamp);
      return { ok: true, detail: "" };
    },
  };
  return { io, stamps, built };
}

test("a project with no Dockerfile.inspector keeps the shared image and builds nothing", async () => {
  const project = plainProject();
  const home = homeWith({ app: project });
  const docker = fakeDocker();

  const result = await ensureMachineImage(home, machineImageForProject(home, project), docker.io);

  assert.equal(result.ok, true);
  assert.equal(result.built, false);
  assert.equal(result.image, DEFAULT_MACHINE_IMAGE);
  assert.deepEqual(docker.built, [], "nothing to build for a project on the shared image");
});

test("a layered project's image is built when missing, and left alone once current", async () => {
  const project = layeredProject();
  const home = homeWith({ app: project });
  const docker = fakeDocker();
  const machine = machineImageForProject(home, project);

  const first = await ensureMachineImage(home, machine, docker.io);
  assert.equal(first.ok, true);
  assert.equal(first.built, true);
  assert.deepEqual(docker.built, [machine.image]);

  // And the generated Dockerfile really was written where the build
  // names it - plain `fabrica doctor` must not write it, so the build
  // step is the only thing that does.
  const named = machineImageStamp(machineDockerfileFor(machine, () => ""));
  assert.equal(docker.stamps.get(machine.image), named);

  const second = await ensureMachineImage(home, machine, docker.io);
  assert.equal(second.built, false, "a current image must not be rebuilt");
  assert.deepEqual(docker.built, [machine.image], "still just the one build");
});

test("a layered project's image is rebuilt when its own Dockerfile.inspector moves", async () => {
  const project = layeredProject();
  const home = homeWith({ app: project });
  const docker = fakeDocker();

  await ensureMachineImage(home, machineImageForProject(home, project), docker.io);
  writeFileSync(join(project, "Dockerfile.inspector"), "FROM ruby:3.4\nRUN bundle install --jobs 4\n");
  const again = await ensureMachineImage(home, machineImageForProject(home, project), docker.io);

  assert.equal(again.built, true, "either input moving makes the image stale");
  assert.equal(docker.built.length, 2);
});

test("a task is refused with the build's own error, naming the project and the file", async () => {
  // Requirement 4: before a round is spent, in the build's own words.
  const project = layeredProject();
  const home = homeWith({ app: project });
  const docker = fakeDocker({ fails: "ERROR: failed to solve: process did not complete successfully: exit code: 1" });

  await assert.rejects(
    () => requireMachineImage(home, project, docker.io),
    (err: Error) => {
      assert.match(err.message, /could not be built/);
      assert.match(err.message, /failed to solve/, "docker's own last word, not this module's guess");
      assert.ok(err.message.includes(project), err.message);
      assert.ok(err.message.includes("Dockerfile.inspector"), err.message);
      assert.match(err.message, /no attempt was spent/);
      assert.match(err.message, /fabrica doctor --fix/);
      return true;
    }
  );
});

test("a task on a project whose Dockerfile.inspector has gone is refused, and nothing is built", async () => {
  const project = layeredProject();
  const home = homeWith({ app: project });
  const docker = fakeDocker();
  const machine = machineImageForProject(home, project);
  rmSync(join(project, "Dockerfile.inspector"));

  const result = await ensureMachineImage(home, machine, docker.io);
  assert.equal(result.ok, false);
  assert.match(result.detail, /cannot be read/);
  assert.deepEqual(docker.built, [], "a build would fail on the same thing");
});

test("a task on a project whose image is fine is not refused, and gets that image", async () => {
  const project = layeredProject();
  const home = homeWith({ app: project });
  const docker = fakeDocker();

  const image = await requireMachineImage(home, project, docker.io);
  assert.match(image, /^fabrica-machine-/);
  assert.notEqual(image, DEFAULT_MACHINE_IMAGE);
});

test("the refusal message is one string, so every caller says the same thing", () => {
  const project = layeredProject();
  const home = homeWith({ app: project });
  const machine = machineImageForProject(home, project);
  assert.ok(machineImageRefusal(machine, "boom").includes("boom"));
  assert.ok(machineImageRefusal(machine, "boom").includes(machine.image));
});

test("fabrica update builds every registered project's image, one report each", async () => {
  // Requirement 3: a merge that moves Fabrica's own layer makes every
  // project's image stale at once, so nothing is left for the first
  // task on each project to discover.
  const ruby = layeredProject("ruby");
  const go = layeredProject("go");
  const plain = plainProject();
  const home = homeWith({ ruby, go, plain });
  const docker = fakeDocker();

  const reports = await buildRegisteredMachineImages(home, docker.io);

  assert.deepEqual(
    reports.map((one) => [one.name, one.outcome]).sort(),
    [
      ["go", "built"],
      ["plain", "shared"],
      ["ruby", "built"],
    ]
  );
  assert.equal(docker.built.length, 2, "only the two layered projects have anything to build");

  // Run again with nothing moved: both are current, neither rebuilt.
  const second = await buildRegisteredMachineImages(home, docker.io);
  assert.deepEqual(second.filter((one) => one.outcome === "built"), []);
  assert.equal(docker.built.length, 2);
});

test("one project's failed build never stops another project's", async () => {
  // The other half of requirement 4: a project whose image cannot be
  // built is that project's problem, not the machine's.
  const broken = layeredProject("broken");
  const fine = layeredProject("fine");
  const home = homeWith({ broken, fine });

  const built: string[] = [];
  const stamps = new Map<string, string>();
  const io: MachineImageIo = {
    stamp: (image) => stamps.get(image) ?? null,
    baseUser: () => "",
    run: async (cmd) => {
      built.push(cmd.image);
      if (cmd.args.includes(machineImageForProject(home, broken).image)) {
        return { ok: false, detail: "ERROR: no such base image" };
      }
      const arg = cmd.args[cmd.args.indexOf("--build-arg") + 1] ?? "";
      stamps.set(cmd.image, arg.split("=")[1] ?? "");
      return { ok: true, detail: "" };
    },
  };

  const reports = await buildRegisteredMachineImages(home, io);
  const byName = new Map(reports.map((one) => [one.name, one]));

  assert.equal(byName.get("broken")?.outcome, "failed");
  assert.match(byName.get("broken")?.detail ?? "", /no such base image/);
  assert.equal(byName.get("fine")?.outcome, "built", "the other project is still brought forward");
  assert.equal(built.length, 2, "both were attempted");

  // And a task on the healthy one still starts.
  assert.match(await requireMachineImage(home, fine, io), /^fabrica-machine-/);
});

test("a record home with no readable registry yields no builds rather than an error", async () => {
  // Its own FAIL line is `fabrica doctor`'s to print; there is no
  // registry here to read a project's path out of.
  const home = mkdtempSync(join(tmpdir(), "fabrica-machine-badhome-"));
  writeFileSync(join(home, "projects.toml"), "this is not toml at all [[[\n");
  assert.deepEqual(await buildRegisteredMachineImages(home, fakeDocker().io), []);
});

test("a build says what it is about to do before it takes minutes doing it", async () => {
  const project = layeredProject();
  const home = homeWith({ app: project });
  const docker = fakeDocker();
  const said: string[] = [];

  await ensureMachineImage(home, machineImageForProject(home, project), {
    ...docker.io,
    onBuilding: (machine, command) => said.push(`${machine.image} ${command.shell}`),
  });
  assert.equal(said.length, 1, said.join("\n"));
  assert.match(said[0], /docker build/);

  // Said once, for a build - never for an image that is already there.
  await ensureMachineImage(home, machineImageForProject(home, project), {
    ...docker.io,
    onBuilding: () => said.push("again"),
  });
  assert.equal(said.length, 1);
});

test("the generated Dockerfile is written under the record home, never into the project", async () => {
  const project = layeredProject();
  const home = homeWith({ app: project });
  const docker = fakeDocker();
  const machine = machineImageForProject(home, project);

  await ensureMachineImage(home, machine, docker.io);

  const written = join(home, "images", `${machine.image.replace(/[:/]/g, "-")}.Dockerfile`);
  assert.ok(existsSync(written), written);
  assert.match(readFileSync(written, "utf8"), /^FROM ruby:3\.4$/m, "the project's own file comes first, verbatim");
  assert.ok(!existsSync(join(project, "Dockerfile")), "nothing Fabrica generates belongs in the Client's repository");
});

// Issue #342: a project whose image build needs a credential this
// machine does not have. The refusal has to be the credential's own,
// not the "its Dockerfile.inspector cannot be read" sentence that every
// other composition failure here gets - that one would send the Client
// to restore a file that is perfectly fine.
test("a task on a project whose build credential is missing is refused in the credential's own words", async () => {
  const project = layeredProject("needs-a-secret");
  writeFileSync(
    join(project, ".inspector.json"),
    `${JSON.stringify({ check: "./check.sh", buildSecrets: ["BUNDLE_GEMS__EXAMPLE__COM"] }, null, 2)}\n`
  );
  const home = homeWith({ app: project });
  const { io, built } = fakeDocker();

  const result = await ensureMachineImage(home, machineImageForProject(home, project), io);

  assert.equal(result.ok, false);
  assert.match(result.detail, /BUNDLE_GEMS__EXAMPLE__COM/);
  assert.match(result.detail, /brain\.env/);
  assert.doesNotMatch(result.detail, /cannot be read/, result.detail);
  assert.deepEqual(built, [], "nothing is built without the credential - the build would fail inside the image");

  await assert.rejects(() => requireMachineImage(home, project, io), /BUNDLE_GEMS__EXAMPLE__COM/);
});
