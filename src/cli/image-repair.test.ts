// `fabrica up` and `fabrica doctor --fix` supplying the two images a
// task needs, instead of printing a command for the Client to run.
//
// Driven against helpers/fake-docker.mjs on PATH as `docker`, never a
// real daemon: nothing here builds or pulls anything, and the argv
// asserted on is the exact argv a real daemon would have received. The
// two image probes are the real ones (workerImageStatus /
// relayImageStatus, reading through that same fake), so what makes a
// repaired check pass here is the pin it has always read - the
// Dockerfile's own hash arriving as a --build-arg and coming back as
// the image's stamp - and not this suite agreeing with itself.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { installFakeDocker } from "../containment/helpers/install-fake-docker.ts";
import type { FakeDockerConfig } from "../containment/helpers/install-fake-docker.ts";
import {
  relayImagePull,
  relayImageStatus,
  workerImageBuild,
  workerImageStatus,
  RELAY_IMAGE_LABEL,
  WORKER_CLI_LABEL,
  WORKER_IMAGE_LABEL,
} from "../index.ts";
import { DOCKER_LABEL } from "./docker-daemon.ts";
import { repairImages, runImageCommand } from "./image-repair.ts";
import type { DoctorCheck, DoctorProbes } from "./doctor-command.ts";

/** The stamp label the worker image's Dockerfile writes
 * (`LABEL <name>=$DOCKERFILE_SHA256`), needed only to seed an image
 * that was built from an *older* Dockerfile. The fake never takes this
 * name from here when it builds - it re-reads the Dockerfile the build
 * names - so a rename there shows up as this fixture no longer making
 * the check fail, rather than as a silent pass. */
const STAMP_LABEL = "fabrica.dockerfile-sha256";

const ok = (label: string): DoctorCheck => ({ ok: true, label, detail: "fine" });

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
}

/** Doctor's probes with the two image lines answered for real, through
 * whatever the fake docker currently has. Everything else is a stub:
 * this module only ever looks at three labels, and the worker CLI line
 * is a counting stub so a test can prove it is re-asked without the
 * probe behind it trying to run a container. */
function probes(overrides: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    node: () => ok("node"),
    checkout: () => ok("checkout"),
    npmLink: () => ok("npm link"),
    docker: () => ok(DOCKER_LABEL),
    workerImage: () => workerImageStatus(),
    workerCli: () => ok(WORKER_CLI_LABEL),
    relayImage: () => relayImageStatus(),
    workerNetworks: async () => ok("worker networks"),
    workerToken: () => ok("worker token"),
    githubApp: async () => ok("github app"),
    inspector: () => ok("inspector"),
    live: async () => ok("worker token (live)"),
    ...overrides,
  };
}

/** The checks `collectDoctorChecks` would have handed the repair step,
 * for the four labels it reads. */
function collect(p: DoctorProbes): DoctorCheck[] {
  return [p.docker(), p.workerImage(), p.workerCli(), p.relayImage()];
}

function setUp(t: TestContext, config: FakeDockerConfig = {}) {
  const docker = installFakeDocker(t, config);
  return { docker, build: workerImageBuild(), pull: relayImagePull() };
}

/** Only the calls that change the machine - the `image inspect` reads
 * every probe makes are noise for most assertions here. */
function writes(calls: string[][]): string[][] {
  return calls.filter((call) => call[0] === "build" || call[0] === "pull");
}

function lineOf(check: DoctorCheck[], label: string): DoctorCheck {
  const found = check.find((c) => c.label === label);
  assert.ok(found, `no ${label} line`);
  return found;
}

test("a missing worker image is built and a missing relay image pulled, with the exact commands their own fix lines name", async (t) => {
  const { docker, build, pull } = setUp(t);
  const p = probes();
  const collected = collect(p);
  assert.deepEqual(
    collected.filter((c) => !c.ok).map((c) => c.label),
    [WORKER_IMAGE_LABEL, RELAY_IMAGE_LABEL],
    "with no images at all, those two lines are the ones that should fail"
  );

  const io = captureIo();
  const { checks, outcomes } = await repairImages({ checks: collected, probes: p, ...io });

  assert.deepEqual(
    writes(docker.calls()),
    [build.args, pull.args],
    "the repair must run the exact argv the checks print as their fix, worker first"
  );
  assert.deepEqual(docker.images(), [build.image, pull.image]);
  assert.deepEqual(outcomes, [
    { label: WORKER_IMAGE_LABEL, image: build.image, action: "built", ok: true, detail: "" },
    { label: RELAY_IMAGE_LABEL, image: pull.image, action: "pulled", ok: true, detail: "" },
  ]);

  // Re-asked, not assumed: the lines handed back describe the machine
  // as it is now, which is what makes doctor's exit code and up's
  // blocker list honest afterwards.
  assert.equal(lineOf(checks, WORKER_IMAGE_LABEL).ok, true, io.out.join("\n"));
  assert.equal(lineOf(checks, RELAY_IMAGE_LABEL).ok, true, io.out.join("\n"));
  assert.deepEqual(io.err, []);
});

test("it reports what it built - the image, in the past tense, and the command it ran to get it", async (t) => {
  const { build, pull } = setUp(t);
  const p = probes();
  const io = captureIo();
  await repairImages({ checks: collect(p), probes: p, ...io });

  assert.ok(io.out.includes(`  $ ${build.shell}`), io.out.join("\n"));
  assert.ok(io.out.includes(`${WORKER_IMAGE_LABEL}: built ${build.image}.`), io.out.join("\n"));
  assert.ok(io.out.includes(`  $ ${pull.shell}`), io.out.join("\n"));
  assert.ok(io.out.includes(`${RELAY_IMAGE_LABEL}: pulled ${pull.image}.`), io.out.join("\n"));
  // What was wrong is said in the failing check's own words, before
  // anything that takes minutes starts.
  assert.ok(
    io.out.some((line) => line.startsWith(`${WORKER_IMAGE_LABEL}: `) && line.includes("is not built")),
    io.out.join("\n")
  );
});

test("docker's own output is forwarded line by line while the command runs, stderr included", async (t) => {
  // A real `docker build` writes every progress line to stderr, so a
  // step that only forwarded stdout would look like a silent hang for
  // the several minutes a build takes.
  const { build } = setUp(t, { buildOutput: "#5 [4/5] RUN npm install -g\n#5 DONE 41.2s\n", pullOutput: "pull said this\n" });
  const p = probes();
  const io = captureIo();
  await repairImages({ checks: collect(p), probes: p, ...io });

  assert.ok(io.out.includes("  #5 [4/5] RUN npm install -g"), io.out.join("\n"));
  assert.ok(io.out.includes("  #5 DONE 41.2s"), io.out.join("\n"));
  assert.ok(io.out.includes("  pull said this"), io.out.join("\n"));
  assert.ok(
    io.out.indexOf("  #5 DONE 41.2s") < io.out.indexOf(`${WORKER_IMAGE_LABEL}: built ${build.image}.`),
    "the command's own output belongs before the outcome line, not after it"
  );
});

test("a worker image built from an older Dockerfile is rebuilt, and the pin it was measured against is the one that passes it", async (t) => {
  const build = workerImageBuild();
  const { docker } = setUp(t, {
    images: [
      { Name: build.image, Labels: { [STAMP_LABEL]: "0".repeat(64) } },
      { Name: relayImagePull().image, Labels: {} },
    ],
  });
  const p = probes();
  const collected = collect(p);
  const before = lineOf(collected, WORKER_IMAGE_LABEL);
  assert.equal(before.ok, false);
  assert.match(before.detail, /out of date/);

  const io = captureIo();
  const { checks, outcomes } = await repairImages({ checks: collected, probes: p, ...io });

  assert.deepEqual(writes(docker.calls()), [build.args], "the relay image was already here - only the worker image needed building");
  assert.deepEqual(outcomes.map((o) => o.label), [WORKER_IMAGE_LABEL]);
  // Nothing in the repair decides this: the build carried the
  // Dockerfile's own hash as --build-arg DOCKERFILE_SHA256, the fake
  // stamped the image from the Dockerfile's own LABEL line, and the
  // untouched check read the two back and agreed.
  assert.equal(lineOf(checks, WORKER_IMAGE_LABEL).ok, true, io.out.join("\n"));
  assert.match(lineOf(checks, WORKER_IMAGE_LABEL).detail, /built and current/);
});

test("the worker CLI line is re-asked after a build, since the image under it was just replaced", async (t) => {
  setUp(t);
  let cliAsked = 0;
  const p = probes({
    workerCli: () => {
      cliAsked += 1;
      return ok(WORKER_CLI_LABEL);
    },
  });
  const collected = collect(p);
  assert.equal(cliAsked, 1, "once, during collection");

  await repairImages({ checks: collected, probes: p, ...captureIo() });
  assert.equal(cliAsked, 2, "and once more, after the image it reads was rebuilt");
});

test("a failing worker CLI line is never a trigger on its own - a rebuild cannot change what a cached build installs", async (t) => {
  const built = workerImageBuild();
  const pulled = relayImagePull();
  const { docker } = setUp(t, {
    images: [
      { Name: built.image, Labels: {} },
      { Name: pulled.image, Labels: {} },
    ],
  });
  const p = probes({
    workerImage: () => ok(WORKER_IMAGE_LABEL),
    workerCli: () => ({ ok: false, label: WORKER_CLI_LABEL, detail: "a different version is installed", fix: "rebuild" }),
  });

  const io = captureIo();
  const { checks, outcomes } = await repairImages({ checks: collect(p), probes: p, ...io });

  assert.deepEqual(writes(docker.calls()), [], "nothing may be built or pulled for that line alone");
  assert.deepEqual(outcomes, []);
  assert.equal(lineOf(checks, WORKER_CLI_LABEL).ok, false, "and it keeps its own FAIL and its own fix");
});

test("nothing to do: every image line passing means no docker command runs at all", async (t) => {
  const { docker } = setUp(t, { images: [{ Name: relayImagePull().image, Labels: {} }] });
  const p = probes({ workerImage: () => ok(WORKER_IMAGE_LABEL) });

  const io = captureIo();
  const { checks, outcomes } = await repairImages({ checks: collect(p), probes: p, ...io });

  assert.deepEqual(writes(docker.calls()), []);
  assert.deepEqual(outcomes, []);
  assert.deepEqual(io.out, [], "and it says nothing - there was nothing to report");
  assert.ok(checks.every((c) => c.ok), checks.map((c) => `${c.label}: ${c.detail}`).join("\n"));
});

test("no Docker daemon: nothing is attempted, and the docker line keeps the only fix there is", async (t) => {
  const { docker } = setUp(t);
  const p = probes({
    docker: () => ({ ok: false, label: DOCKER_LABEL, detail: "not reachable", fix: "start Docker" }),
  });

  const io = captureIo();
  const { checks, outcomes } = await repairImages({ checks: collect(p), probes: p, ...io });

  assert.deepEqual(writes(docker.calls()), [], "a build with no daemon can only fail a second time and bury the real line");
  assert.deepEqual(outcomes, []);
  assert.deepEqual(io.out, []);
  assert.equal(lineOf(checks, DOCKER_LABEL).fix, "start Docker");
  assert.equal(lineOf(checks, WORKER_IMAGE_LABEL).ok, false);
});

test("a build that fails is reported in docker's own words, leaves the check failing, and does not skip the pull", async (t) => {
  const { docker, build, pull } = setUp(t, { buildFailure: "no space left on device" });
  const p = probes();

  const io = captureIo();
  const { checks, outcomes } = await repairImages({ checks: collect(p), probes: p, ...io });

  assert.deepEqual(writes(docker.calls()), [build.args, pull.args], "the relay image is a separate problem and still gets pulled");
  assert.deepEqual(outcomes, [
    {
      label: WORKER_IMAGE_LABEL,
      image: build.image,
      action: "built",
      ok: false,
      detail: "Error response from daemon: no space left on device",
    },
    { label: RELAY_IMAGE_LABEL, image: pull.image, action: "pulled", ok: true, detail: "" },
  ]);
  assert.ok(
    io.err.some((line) => line === `${WORKER_IMAGE_LABEL}: could not be built - Error response from daemon: no space left on device`),
    io.err.join("\n")
  );
  // Re-asked anyway, so the report is the machine as it is - still
  // without the image, still carrying the fix.
  const after = lineOf(checks, WORKER_IMAGE_LABEL);
  assert.equal(after.ok, false);
  assert.equal(after.fix, `run from any folder: ${build.shell}`);
  assert.equal(lineOf(checks, RELAY_IMAGE_LABEL).ok, true);
});

test("a pull that fails is reported the same way, and the worker image it has nothing to do with is still built", async (t) => {
  const { docker, build, pull } = setUp(t, { pullFailure: "manifest unknown" });
  const p = probes();

  const io = captureIo();
  const { checks, outcomes } = await repairImages({ checks: collect(p), probes: p, ...io });

  assert.deepEqual(writes(docker.calls()), [build.args, pull.args]);
  assert.deepEqual(outcomes.map((o) => [o.label, o.ok]), [
    [WORKER_IMAGE_LABEL, true],
    [RELAY_IMAGE_LABEL, false],
  ]);
  assert.ok(
    io.err.some((line) => line.startsWith(`${RELAY_IMAGE_LABEL}: could not be pulled - `) && line.includes("manifest unknown")),
    io.err.join("\n")
  );
  assert.equal(lineOf(checks, WORKER_IMAGE_LABEL).ok, true);
  assert.equal(lineOf(checks, RELAY_IMAGE_LABEL).ok, false);
  assert.equal(lineOf(checks, RELAY_IMAGE_LABEL).fix, pull.shell);
});

test("a `docker` that cannot be spawned at all is an outcome, not a thrown error", async () => {
  // Deliberately no PATH shim here and no fake to answer: the command
  // itself does not exist, which is the one failure that reaches the
  // spawn's error event rather than a non-zero exit.
  const io = captureIo();
  const p = probes({
    workerImage: () => ({ ok: false, label: WORKER_IMAGE_LABEL, detail: "not built", fix: "build it" }),
    relayImage: () => ok(RELAY_IMAGE_LABEL),
    workerCli: () => ok(WORKER_CLI_LABEL),
  });
  const { outcomes } = await repairImages({
    checks: collect(p),
    probes: p,
    runImageCommand: () => runImageCommand({ ...workerImageBuild(), command: "fabrica-no-such-docker" }, () => {}),
    ...io,
  });

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].ok, false);
  assert.match(outcomes[0].detail, /ENOENT/);
  assert.ok(io.err.some((line) => line.includes("could not be built")), io.err.join("\n"));
});

test("the fix lines the checks print and the commands the repair runs are the same command, not two spellings", () => {
  const build = workerImageBuild();
  const pull = relayImagePull();
  assert.equal(build.shell, `cd ${build.cwd} && ${build.command} ${build.args.join(" ")}`);
  assert.equal(pull.shell, `${pull.command} ${pull.args.join(" ")}`);
  assert.equal(workerImageStatus(() => null).fix, `run from any folder: ${build.shell}`);
  assert.equal(relayImageStatus(() => false).fix, pull.shell);
});
