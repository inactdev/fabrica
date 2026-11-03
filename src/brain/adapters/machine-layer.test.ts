import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  finalStageBaseImage,
  finalStageUser,
  machineDockerfile,
  machineRestoreUser,
  machineLauncherPrintf,
  machineLayer,
  pinnedMachineNodeVersion,
  MACHINE_CLI_DIR,
  MACHINE_CLI_INSTALLED,
  MACHINE_CLI_PATH,
  MACHINE_LAUNCHER_LINES,
  MACHINE_NODE_DIR,
  MACHINE_STAMP_ARG,
} from "./machine-layer.ts";
import { DOCKERFILE_STAMP_LABEL, pinnedCliVersion, WORKER_CLI_PACKAGE } from "./doctor-checks.ts";

const PINS = { node: "9.9.9", cli: "7.7.7" };

/** A base image that runs as root - i.e. whose own configuration names
 * no user. Every test here hands in its own stand-in for that probe, so
 * none of them reaches a real daemon; what a real base image actually
 * carries is machine-image-build.test.ts's to prove, with a real build
 * against a real `cimg/go`. */
const ROOT_BASE = () => "";

/** A probe that must never be called: the project's own file already
 * names the user, so there is nothing to ask the base image. */
const UNASKED = (): string => {
  throw new Error("the base image must not be asked when the project's own file names a user");
};

/** Every `RUN` body in a Dockerfile, with its line continuations joined
 * - what the shell inside the image is actually handed. */
function runBodies(dockerfile: string): string[] {
  return dockerfile
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .filter((line) => line.startsWith("RUN "))
    .map((line) => line.slice(4));
}

test("the layer names the two pins it was given, and nothing else's version", () => {
  const layer = machineLayer(PINS);

  assert.match(layer, /node-v\$version-linux-\$arch\$libc\.tar\.gz/, "the tarball name has to be built from the pinned version");
  assert.match(layer, /version="9\.9\.9"/);
  assert.match(layer, new RegExp(`${WORKER_CLI_PACKAGE.replace("/", "\\/")}@7\\.7\\.7`));
});

test("the layer refuses to build at all when either pin has gone missing", () => {
  // A reworded worker Dockerfile is a bug in this repository, and a
  // layer installing a version nothing here has verified is worse than a
  // loud refusal.
  assert.throws(() => machineLayer({ node: null, cli: "7.7.7" }), /no longer names the Node version/);
  assert.throws(() => machineLayer({ node: "9.9.9", cli: null }), /pins no exact version/);
});

test("the pinned Node version is read from the worker Dockerfile's own base tag", () => {
  assert.equal(pinnedMachineNodeVersion(() => "FROM node@sha256:abc\n# node:22.1.0-alpine\n"), "22.1.0");
  assert.equal(pinnedMachineNodeVersion(() => "FROM debian\n"), null);
});

test("every shell step in the layer is valid POSIX sh", () => {
  // A Dockerfile hands each RUN to /bin/sh -c as one string, so a quoting
  // slip in a refusal message is a build that dies on a syntax error
  // instead of saying what is wrong. Checked by the real shell, not by
  // reading it.
  const dir = mkdtempSync(join(tmpdir(), "fabrica-layer-"));
  const layer = machineDockerfile({ inspectorDockerfile: "FROM debian\n", source: "x", pins: PINS, baseUser: ROOT_BASE });
  runBodies(layer).forEach((body, i) => {
    const script = join(dir, `run-${i}.sh`);
    writeFileSync(script, `${body}\n`);
    execFileSync("sh", ["-n", script]);
  });
});

test("the layer's own prerequisites are refused by name, with the fix, when the image lacks them", () => {
  const checks = machineLayer(PINS);
  for (const tool of ["bash", "git"]) {
    assert.match(checks, new RegExp(`command -v ${tool} .*\\|\\| fail "the machine's box needs ${tool}`));
    assert.match(checks, new RegExp(`Add ${tool} to it\\.`));
  }
  // A silent skip here is a box that cannot run one command.
  assert.match(checks, /needs curl or wget/);
  assert.match(checks, /needs sha256sum or shasum/);
});

test("the prerequisite check really does refuse a tool-less PATH, and pass a complete one", () => {
  // The two outcomes, run for real by the shell that will run them in
  // the image - the first block of the layer, which is the one every
  // project's build reaches first.
  const dir = mkdtempSync(join(tmpdir(), "fabrica-layer-tools-"));
  const script = join(dir, "tools.sh");
  writeFileSync(script, `${runBodies(machineLayer(PINS))[0]}\n`);

  assert.throws(
    // `/bin/sh` by absolute path, since the PATH being handed in is the
    // whole point of the test and would otherwise hide the shell too.
    () => execFileSync("/bin/sh", [script], { env: { PATH: dir }, stdio: ["ignore", "pipe", "pipe"] }),
    (err: Error & { stderr?: Buffer }) => {
      assert.match(String(err.stderr), /fabrica: the machine's box needs bash/);
      return true;
    },
    "an image with neither tool must refuse, naming the first one missing"
  );
  // bash and git are both prerequisites of this project's own suite, so
  // a PATH that can run this test can satisfy the check.
  execFileSync("sh", [script], { stdio: "ignore" });
});

test("Node goes somewhere that is never on PATH, and only the CLI launcher is added to it", () => {
  const layer = machineLayer(PINS);

  // The whole point: a project's own node, ruby or go stays the one its
  // own check runs on. Adding Fabrica's node to PATH would make a Node
  // project's check run on a different version here than in Inspector's
  // box, which is the divergence this exists to remove.
  assert.doesNotMatch(layer, /^ENV PATH/m, "the layer must not change the image's own PATH");
  assert.match(layer, new RegExp(`tar -xzf "\\$file" -C ${MACHINE_NODE_DIR}`));
  assert.match(layer, new RegExp(`> ${MACHINE_CLI_PATH}`));
  assert.ok(MACHINE_CLI_PATH.startsWith(`${MACHINE_CLI_DIR}/`));
  // And the one new command is proved reachable at build time, rather
  // than assumed.
  assert.match(layer, /found="\$\(command -v claude \|\| true\)"/);
});

test("the install writes a launcher at exactly the path the self-check demands", () => {
  // Requirement 1 of issue #322's amendment, and the defect that made
  // every per-project image unbuildable the first time this landed: the
  // place the install puts `claude` and the place the self-check looks
  // for it have to be one string, not two that happen to agree.
  const layer = machineLayer(PINS);

  assert.match(layer, new RegExp(`${machineLauncherPrintf().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} > ${MACHINE_CLI_PATH};`));
  assert.match(layer, new RegExp(`\\[ "\\$found" = "${MACHINE_CLI_PATH}" \\]`));
  // And the one thing the launcher names is proved runnable before
  // anything that points at it is written.
  assert.match(layer, new RegExp(`\\[ -x ${MACHINE_CLI_INSTALLED} \\] \\|\\| fail`));
});

test("the launcher names no interpreter, and changes no PATH", () => {
  // At the pinned version the installed command is a self-contained
  // native executable (the package's bin is a stub its own postinstall
  // replaces with a platform binary). Running it through Node - what the
  // first version of this layer did - is Node being asked to parse an
  // executable as JavaScript, so nothing in any project's image could
  // run. And a PATH set here would reach the project's own check, since
  // the worker's shell tool spawns it as a child of this process.
  const launcher = MACHINE_LAUNCHER_LINES.join("\n");

  assert.equal(MACHINE_LAUNCHER_LINES[0], "#!/bin/sh");
  // Exactly one command, and it is the installed CLI itself - not that
  // CLI handed to something else.
  assert.deepEqual(
    MACHINE_LAUNCHER_LINES.filter((line) => !line.startsWith("#")),
    [`exec "${MACHINE_CLI_INSTALLED}" "$@"`]
  );
  assert.doesNotMatch(launcher, new RegExp(`${MACHINE_NODE_DIR}/bin/node\\b`), `no interpreter: ${launcher}`);
  assert.doesNotMatch(launcher, /PATH/, `the launcher must set no PATH: ${launcher}`);
});

test("the launcher refuses to be generated with anything printf or the shell would eat", () => {
  // The launcher is written by one single-quoted printf, so a `%`, a
  // quote or a backslash in it would silently produce a different file
  // from the one read here.
  assert.equal(machineLauncherPrintf(["a", "b"]), "printf 'a\\nb\\n'");
  for (const bad of ["100% sure", "it's here", "a\\b"]) {
    assert.throws(() => machineLauncherPrintf([bad]), /rewrite the line without it/, bad);
  }
});

test("the install defends against the two settings that leave the CLI installed but inert", () => {
  // The package's own stub names them: --ignore-scripts skips the
  // postinstall that puts the real binary in place, and --omit=optional
  // leaves the platform package it comes from undownloaded. Either can
  // arrive from a base image's npmrc or environment rather than from
  // this line, so this line says otherwise explicitly.
  const layer = machineLayer(PINS);
  assert.match(layer, /npm install -g .*--include=optional/);
  assert.match(layer, /npm install -g .*--ignore-scripts=false/);
});

test("the download is verified against the release's own published checksum", () => {
  const layer = machineLayer(PINS);

  assert.match(layer, /SHASUMS256\.txt/);
  assert.match(layer, /\[ "\$actual" = "\$expected" \] \|\| fail/, "a mismatch must refuse, never install");
  // An architecture or libc that release never published has no line in
  // that file, and that is what the refusal names.
  assert.match(layer, /publishes no \$file for v\$version/);
});

test("a project's own Dockerfile comes first, verbatim, and the user it ends as is restored", () => {
  const own = ["FROM cimg/node:24.18.0", "USER root", "RUN mkdir -p /deps", "USER circleci", "RUN cd /deps && npm ci"].join("\n");
  const generated = machineDockerfile({
    inspectorDockerfile: `${own}\n`,
    source: "/p/Dockerfile.inspector",
    pins: PINS,
    baseUser: UNASKED,
  });

  assert.ok(generated.includes(`${own}\n`), "the project's own file must appear unchanged and unreordered");
  assert.ok(generated.indexOf("FROM cimg/node:24.18.0") < generated.indexOf("USER root\n\n# What this layer needs"));
  assert.match(generated, /USER circleci\n$/, "the layer switches to root, so it has to switch back");
  assert.match(generated, /Built from \/p\/Dockerfile\.inspector/);
});

test("a project's Dockerfile on a base that itself runs as root has no user restored", () => {
  // The base image's own configuration naming no user is what "root"
  // means, and the only thing that means it.
  const generated = machineDockerfile({ inspectorDockerfile: "FROM debian:13\n", source: "x", pins: PINS, baseUser: ROOT_BASE });
  assert.doesNotMatch(generated, /\nUSER (?!root)/, "the only USER here is the layer's own switch to root");
});

test("a base image's own user is restored even though no Dockerfile line names it", () => {
  // The defect this covers, found by a real build: every `cimg/*` image
  // runs as `circleci`, set inside the image itself. A project's own
  // Dockerfile.inspector need not mention it, and reading only text left
  // the machine's box running as root - which is not the box its checks
  // were written for.
  const asked: string[] = [];
  const generated = machineDockerfile({
    inspectorDockerfile: "FROM cimg/go:1.26.10\n",
    source: "x",
    pins: PINS,
    baseUser: (image) => {
      asked.push(image);
      return "circleci";
    },
  });

  assert.deepEqual(asked, ["cimg/go:1.26.10"], "the image the final stage is built FROM, as written");
  assert.match(generated, /USER circleci\n$/, "the layer switches to root, so it has to switch back");
  // And the generated file says where that came from, since a reader of
  // it will not find `circleci` anywhere above.
  assert.match(generated, /cimg\/go:1\.26\.10 itself runs as/);
});

test("a user that cannot be worked out refuses, rather than quietly becoming root", () => {
  // Root is a real answer here, so guessing it when the question could
  // not be asked would be indistinguishable from having asked.
  assert.throws(
    () => machineRestoreUser("FROM cimg/go:1.26.10\n", () => null),
    /could not be read .*docker image inspect cimg\/go:1\.26\.10/,
    "a daemon that cannot answer"
  );
  assert.throws(
    () => machineRestoreUser("FROM $BASE_IMAGE\n", ROOT_BASE),
    /cannot be read out of it either/,
    "a FROM whose value belongs to the build, not to the file"
  );
  assert.equal(machineRestoreUser("FROM a\nUSER one\n", UNASKED), "one", "and a named user is still read off the text");
  assert.equal(machineRestoreUser("FROM a\n", () => "someone"), "someone");
  assert.equal(machineRestoreUser("FROM a\n", ROOT_BASE), null, "only an empty configured user means root");
});

test("finalStageBaseImage resolves which image the last stage is really built on", () => {
  assert.equal(finalStageBaseImage("FROM ruby:3.4\nRUN true\n"), "ruby:3.4");
  // An earlier stage is followed back to the image it was built on,
  // since the question is always about a real image on a registry.
  assert.equal(finalStageBaseImage("FROM ruby:3.4 AS deps\nFROM deps\n"), "ruby:3.4");
  assert.equal(finalStageBaseImage("FROM ruby:3.4 as deps\nFROM DEPS\n"), "ruby:3.4", "a stage name is case-insensitive");
  assert.equal(finalStageBaseImage("FROM ruby:3.4\nFROM 0\n"), "ruby:3.4", "numbered as well as named");
  assert.equal(finalStageBaseImage("FROM --platform=linux/amd64 ruby:3.4\n"), "ruby:3.4", "flags are not the argument");
  assert.equal(finalStageBaseImage("FROM a AS one\nFROM b AS two\nFROM one\n"), "a", "the last stage, not the last FROM");
  // Only an *earlier* stage is a stage: a name that matches nothing
  // before it is an image's name, which is also docker's own reading.
  assert.equal(finalStageBaseImage("FROM self AS self\n"), "self");
  // Unresolvable, and said so rather than guessed:
  assert.equal(finalStageBaseImage("FROM $BASE\n"), null);
  assert.equal(finalStageBaseImage("RUN true\n"), null);
});

test("finalStageUser reads the last USER of the last stage only", () => {
  assert.equal(finalStageUser("FROM a\nUSER one\n"), "one");
  assert.equal(finalStageUser("FROM a\nUSER one\nUSER two\n"), "two");
  // An earlier stage's user belongs to an image this build does not produce.
  assert.equal(finalStageUser("FROM a AS build\nUSER one\nFROM b\nRUN true\n"), null);
  assert.equal(finalStageUser("FROM a AS build\nUSER one\nFROM b\nUSER two\n"), "two");
  assert.equal(finalStageUser("FROM a\nRUN true\n"), null);
  assert.equal(finalStageUser("  from a\n  user spaced  \n"), "spaced");
});

test("the stamp arrives as a build arg and is stored under the one stamp label", () => {
  // It cannot be written into the file directly: the file is what is
  // being hashed.
  const generated = machineDockerfile({ inspectorDockerfile: "FROM debian:13\n", source: "x", pins: PINS, baseUser: ROOT_BASE });
  assert.match(generated, new RegExp(`ARG ${MACHINE_STAMP_ARG}=""`));
  assert.match(generated, new RegExp(`LABEL ${DOCKERFILE_STAMP_LABEL}=\\$${MACHINE_STAMP_ARG}`));
});

test("the real pins behind the layer are both readable from the worker Dockerfile", () => {
  // The defaults, with nothing injected - so a reworded pin in that file
  // fails here rather than at a project's first build.
  assert.match(pinnedMachineNodeVersion() ?? "", /^\d+\.\d+\.\d+$/);
  assert.match(pinnedCliVersion() ?? "", /^\d+\.\d+\.\d+/);
  assert.doesNotThrow(() => machineLayer());
});
