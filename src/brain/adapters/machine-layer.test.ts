import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  finalStageUser,
  machineDockerfile,
  machineLayer,
  pinnedMachineNodeVersion,
  MACHINE_CLI_DIR,
  MACHINE_CLI_PATH,
  MACHINE_NODE_DIR,
  MACHINE_STAMP_ARG,
} from "./machine-layer.ts";
import { DOCKERFILE_STAMP_LABEL, pinnedCliVersion, WORKER_CLI_PACKAGE } from "./doctor-checks.ts";

const PINS = { node: "9.9.9", cli: "7.7.7" };

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
  runBodies(machineDockerfile({ inspectorDockerfile: "FROM debian\n", source: "x", pins: PINS })).forEach((body, i) => {
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

test("Node goes somewhere that is never on PATH, and only the CLI wrapper is added to it", () => {
  const layer = machineLayer(PINS);

  // The whole point: a project's own node, ruby or go stays the one its
  // own check runs on. Adding Fabrica's node to PATH would make a Node
  // project's check run on a different version here than in Inspector's
  // box, which is the divergence this exists to remove.
  assert.doesNotMatch(layer, /^ENV PATH/m, "the layer must not change the image's own PATH");
  assert.match(layer, new RegExp(`tar -xzf "\\$file" -C ${MACHINE_NODE_DIR}`));
  assert.match(layer, new RegExp(`printf '#!/bin/sh\\\\nexec ${MACHINE_NODE_DIR}/bin/node`));
  assert.match(layer, new RegExp(`> ${MACHINE_CLI_PATH}`));
  assert.ok(MACHINE_CLI_PATH.startsWith(`${MACHINE_CLI_DIR}/`));
  // And the one new command is proved reachable at build time, rather
  // than assumed.
  assert.match(layer, /found="\$\(command -v claude \|\| true\)"/);
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
  const generated = machineDockerfile({ inspectorDockerfile: `${own}\n`, source: "/p/Dockerfile.inspector", pins: PINS });

  assert.ok(generated.includes(`${own}\n`), "the project's own file must appear unchanged and unreordered");
  assert.ok(generated.indexOf("FROM cimg/node:24.18.0") < generated.indexOf("USER root\n\n# What this layer needs"));
  assert.match(generated, /USER circleci\n$/, "the layer switches to root, so it has to switch back");
  assert.match(generated, /Built from \/p\/Dockerfile\.inspector/);
});

test("a project's Dockerfile that names no user has none restored", () => {
  const generated = machineDockerfile({ inspectorDockerfile: "FROM debian:13\n", source: "x", pins: PINS });
  assert.doesNotMatch(generated, /\nUSER (?!root)/, "the only USER here is the layer's own switch to root");
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
  const generated = machineDockerfile({ inspectorDockerfile: "FROM debian:13\n", source: "x", pins: PINS });
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
