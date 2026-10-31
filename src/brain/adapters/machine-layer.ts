// The layer Fabrica puts on top of a project's own check image, so the
// box a machine writes in is the box its work is judged in (issue #322).
//
// Before this, every machine ran in one shared image carrying Node, the
// worker CLI and a Go toolchain - and nothing else. A project whose
// checks are `bundle exec rspec` had no `bundle` in that box, so its
// machine could not run the tests covering what it touched and worked
// blind until Inspector judged it afterwards. The project's own
// toolchain already exists, declared in its `Dockerfile.inspector`;
// this file is what puts the worker CLI on top of it.
//
// Here, and not in `src/projectimage/`, for the reason every brand name
// in this project lives under `adapters/`: the layer installs a named
// CLI at a pinned version, and CONTRACT rule 8's scan would flag that
// text anywhere else under `src/`.
//
// Two rules this layer obeys, both the hard way on purpose:
//
//   1. **It shadows nothing the project declared.** Fabrica's Node goes
//      to /opt/fabrica/node, which is never put on PATH; the only new
//      command in the box is a `claude` wrapper that execs that Node
//      directly. Prepending Fabrica's Node to PATH would make a Node
//      project's check run on Fabrica's version in the machine's box and
//      on its own in Inspector's - the very divergence this issue
//      removes, one layer down. Appending it would leave the CLI's own
//      `#!/usr/bin/env node` resolving to the project's Node instead,
//      which is the same bug pointed the other way.
//   2. **It fails the build loudly, naming the fix, for anything it
//      needs and cannot install.** A project image can be based on
//      anything, so there is no package manager this can assume: no
//      bash (the CLI's own Bash tool requires a real one - issue #89,
//      verified live), no git (the read-only `.git` mount is useless
//      without it), no downloader, no checksum tool, an architecture or
//      a libc Node publishes no build for. A silent skip would hand the
//      Client a box that cannot run a single command.
//
// Both version pins stay in src/brain/adapters/docker/Dockerfile - the
// one place they have always lived - and are read out of it here rather
// than copied: the Node version from its `node:<x.y.z>-alpine` base tag
// and the CLI version from its `npm install -g` line.
// src/cli/node-version-pins.test.ts binds the first to `.node-version`
// alongside the other four declarations.

import { readFileSync } from "node:fs";
import { DOCKERFILE_STAMP_LABEL, pinnedCliVersion, WORKER_DOCKERFILE, WORKER_CLI_PACKAGE } from "./doctor-checks.ts";

/** The build arg carrying the generated Dockerfile's own hash, which is
 * what `fabrica doctor` compares an existing image against. It cannot be
 * written into the file directly - the file is what is being hashed - so
 * it arrives as `--build-arg` and is stored under the same label the
 * shared image's stamp uses. */
export const MACHINE_STAMP_ARG = "FABRICA_IMAGE_STAMP";

/** Where Fabrica's own Node lives in the machine's box: off PATH, so it
 * shadows nothing the project's image already provides. */
export const MACHINE_NODE_DIR = "/opt/fabrica/node";

/** Where the one command Fabrica's layer adds to the box goes. Not a
 * directory of Fabrica's own added to PATH: `ENV PATH="$PATH:..."`
 * expands against whatever the base image's own config happens to set,
 * and an image that sets none would leave an empty element in PATH -
 * which means the current directory. A directory every base image
 * already has on PATH, asserted at build time, is the arrangement with
 * nothing to get wrong. */
export const MACHINE_CLI_DIR = "/usr/local/bin";

/** The one command Fabrica's layer adds to PATH. */
export const MACHINE_CLI_PATH = `${MACHINE_CLI_DIR}/claude`;

/** Where a release's tarballs and its own published checksums both come
 * from. Named once: the layer's download, its verification and its
 * failure messages all have to be about the same release directory. */
export const NODE_RELEASE_BASE = "https://nodejs.org/dist";

/** The Node version the worker Dockerfile pins, read from the tag its
 * digest-pinned base image resolves to - the same spelling (and the same
 * one record of which Node that digest is) `node-version-pins.test.ts`
 * reads. Null when that spelling is not there at all, which is a
 * reworded Dockerfile rather than an unpinned one; `machineLayer` refuses
 * on it rather than guessing a version. */
export function pinnedMachineNodeVersion(dockerfile: () => string = () => readFileSync(WORKER_DOCKERFILE, "utf8")): string | null {
  return /\bnode:(\d+\.\d+\.\d+)-alpine\b/.exec(dockerfile())?.[1] ?? null;
}

/** The user a Dockerfile leaves its final stage running as, or null when
 * it names none and the image's own default stands.
 *
 * Only the final stage is read: an earlier stage's `USER` belongs to an
 * image this build is not producing. The last `USER` wins, because a
 * Dockerfile that switches to root to install and back again (the shape
 * `fabrica register` itself writes for a `cimg/*` base) has two. */
export function finalStageUser(dockerfile: string): string | null {
  const lines = dockerfile.split("\n").map((line) => line.trim());
  let user: string | null = null;
  for (const line of lines) {
    if (/^FROM\s/i.test(line)) user = null;
    const named = /^USER\s+(\S+)/i.exec(line);
    if (named) user = named[1];
  }
  return user;
}

/** Shell, as a Dockerfile `RUN` writes it: one command per line, each
 * continued, so a build log points at a real line. */
function run(lines: string[]): string {
  return `RUN ${lines.join(" \\\n    ")}`;
}

/** One loud refusal inside the layer's own shell: the message, then a
 * non-zero exit. Written as a shell function so every check reads the
 * same way and no message can quietly become a warning. */
const REFUSE = `fail() { echo "fabrica: $1" >&2; exit 1; };`;

/** The prerequisites Fabrica's layer needs the project's image to carry
 * and cannot install itself, since a project image can be based on
 * anything and no package manager is safe to assume here. */
const REQUIRED_TOOLS: readonly { tool: string; why: string }[] = [
  { tool: "bash", why: "the worker's own shell tool requires a real bash, not busybox's /bin/sh" },
  { tool: "git", why: "the worker reads the project's history through a read-only .git mount" },
];

/** Fabrica's layer, as Dockerfile text, appended to a project's own
 * `Dockerfile.inspector` by `machineDockerfile` below. Throws when
 * either pin cannot be read out of the worker Dockerfile - a reworded
 * pin is a bug in this repository, and a layer built on a guessed
 * version would install something nothing here has ever verified. */
export function machineLayer(
  pins: { node?: string | null; cli?: string | null } = {}
): string {
  const node = pins.node === undefined ? pinnedMachineNodeVersion() : pins.node;
  const cli = pins.cli === undefined ? pinnedCliVersion() : pins.cli;
  if (node === null) {
    throw new Error(
      `${WORKER_DOCKERFILE} no longer names the Node version its base image is (expected a \`node:<x.y.z>-alpine\` ` +
        `tag beside the digest it pins), so the machine's layer has no version to install.`
    );
  }
  if (cli === null) {
    throw new Error(
      `${WORKER_DOCKERFILE} pins no exact version of ${WORKER_CLI_PACKAGE}, so the machine's layer has no version ` +
        `to install - the pin is deliberate (see that file), and a floating version must not reach a project's image.`
    );
  }

  return [
    "# " + "-".repeat(68),
    "# Everything above this line is this project's own Dockerfile.inspector,",
    "# verbatim. Everything below it is Fabrica's machine layer: the worker",
    "# CLI, and the Node it runs on, installed so that nothing the project",
    "# declared is shadowed. Generated - edit src/brain/adapters/machine-layer.ts",
    "# in Fabrica, or Dockerfile.inspector in this project, never this file.",
    "USER root",
    "",
    "# What this layer needs and cannot install: a project's image may be",
    "# based on anything, so there is no package manager to assume here. Said",
    "# now, by name, rather than discovered when the first command in the box",
    "# fails.",
    run([
      "set -eu;",
      REFUSE,
      ...REQUIRED_TOOLS.map(
        ({ tool, why }) =>
          `command -v ${tool} >/dev/null 2>&1 || fail "the machine's box needs ${tool}, which this project's ` +
          `Dockerfile.inspector does not install: ${why}. Add ${tool} to it.";`
      ),
    ]),
    "",
    `# Node ${node}, exactly the version Fabrica's own worker image pins, from`,
    "# nodejs.org's release directory and verified against that release's own",
    "# published SHASUMS256.txt. Installed off PATH on purpose: the project's",
    "# own node, if it has one, stays the one its check runs on.",
    "#",
    "# The file name, the arch names, the checksum file and the grep against it",
    "# are all the Node project's own (its release Makefile's BINARYNAME, and",
    "# the Dockerfiles its official images are built from) - not inferred.",
    "# `.tar.gz` rather than the `.tar.xz` those images take, because both are",
    "# published for every binary release and xz is absent from more base",
    "# images than gzip is.",
    run([
      "set -eu;",
      REFUSE,
      `version="${node}";`,
      `base="${NODE_RELEASE_BASE}/v$version";`,
      'machine="$(uname -m)";',
      'case "$machine" in',
      "x86_64|amd64) arch=x64 ;;",
      "aarch64|arm64) arch=arm64 ;;",
      "armv7l) arch=armv7l ;;",
      "ppc64le) arch=ppc64le ;;",
      "s390x) arch=s390x ;;",
      '*) fail "nodejs.org publishes no Node build for this image\'s architecture ($machine)." ;;',
      "esac;",
      // musl is detected positively, glibc assumed otherwise: `ldd
      // --version` names musl on a musl system (and exits non-zero
      // there, hence the `|| true`), while every glibc spelling of that
      // output differs by distribution.
      //
      // nodejs.org publishes a musl build for x64 only - its own alpine
      // image builds every other architecture from source, which is not
      // something to do inside a project's check image. Nothing branches
      // on that here: an architecture with no published musl build has no
      // line in SHASUMS256.txt, and the refusal below names the exact
      // file that is missing.
      'if (ldd --version 2>&1 || true) | grep -qi musl; then libc=-musl; else libc=""; fi;',
      'file="node-v$version-linux-$arch$libc.tar.gz";',
      "if command -v curl >/dev/null 2>&1; then fetch=\"curl -fsSL -o\";",
      "elif command -v wget >/dev/null 2>&1; then fetch=\"wget -qO\";",
      'else fail "the machine\'s box needs curl or wget to install Node, and this project\'s Dockerfile.inspector installs neither. Add one to it."; fi;',
      "if command -v sha256sum >/dev/null 2>&1; then digest=\"sha256sum\";",
      "elif command -v shasum >/dev/null 2>&1; then digest=\"shasum -a 256\";",
      'else fail "the machine\'s box needs sha256sum or shasum to verify Node\'s download, and this project\'s Dockerfile.inspector installs neither. Add one to it."; fi;',
      'rm -rf /tmp/fabrica-node; mkdir -p /tmp/fabrica-node; cd /tmp/fabrica-node;',
      '$fetch SHASUMS256.txt "$base/SHASUMS256.txt" || fail "could not fetch $base/SHASUMS256.txt - the machine\'s image is built with network access, so this is a build-time network problem, not a containment one.";',
      'expected="$(grep " $file\\$" SHASUMS256.txt | cut -d" " -f1 || true)";',
      '[ -n "$expected" ] || fail "nodejs.org publishes no $file for v$version, so Fabrica cannot install the Node it pins into an image of this shape. Base this project\'s Dockerfile.inspector on an image nodejs.org publishes a build for.";',
      '$fetch "$file" "$base/$file" || fail "could not download $base/$file.";',
      'actual="$($digest "$file" | cut -d" " -f1)";',
      '[ "$actual" = "$expected" ] || fail "$file does not match its published checksum (expected $expected, got $actual) - refusing to install it.";',
      `mkdir -p ${MACHINE_NODE_DIR};`,
      // --no-same-owner so everything lands owned by root and stays
      // readable to whoever the box runs as, rather than keeping the uids
      // the tarball was built with. Both flags are what the Node
      // project's own images use, including on Alpine - so busybox tar
      // takes them too.
      `tar -xzf "$file" -C ${MACHINE_NODE_DIR} --strip-components=1 --no-same-owner;`,
      "cd /; rm -rf /tmp/fabrica-node;",
      `[ -x ${MACHINE_NODE_DIR}/bin/node ] || fail "the Node tarball left no runnable ${MACHINE_NODE_DIR}/bin/node.";`,
    ]),
    "",
    `# ${WORKER_CLI_PACKAGE} ${cli}, the version Fabrica's own worker image`,
    "# pins, installed with the Node above and reached through a wrapper that",
    "# names that Node explicitly - so the CLI never needs its own interpreter",
    "# on PATH, and the project's node never becomes it.",
    run([
      "set -eu;",
      REFUSE,
      `export PATH="${MACHINE_NODE_DIR}/bin:$PATH";`,
      `npm install -g --prefix ${MACHINE_NODE_DIR} --no-audit --no-fund ${WORKER_CLI_PACKAGE}@${cli};`,
      // Read back from what npm actually installed, never a guessed path
      // inside the package: the wrapper has to name a real entry point.
      `entry="$(readlink -f ${MACHINE_NODE_DIR}/bin/claude || true)";`,
      '[ -n "$entry" ] && [ -f "$entry" ] || fail "npm installed the worker CLI but left no runnable entry point to wrap.";',
      `mkdir -p ${MACHINE_CLI_DIR};`,
      `printf '#!/bin/sh\\nexec ${MACHINE_NODE_DIR}/bin/node "%s" "$@"\\n' "$entry" > ${MACHINE_CLI_PATH};`,
      `chmod 0755 ${MACHINE_CLI_PATH};`,
    ]),
    "",
    "# That the box can actually reach it, proved rather than assumed - and in",
    "# its own fresh shell, with the image's own PATH, which is the PATH a",
    "# machine will have. Not in the step above: that one puts Fabrica's own",
    "# bin directory on PATH for npm's benefit, so it is the one shell in this",
    "# image where the answer would be a different file.",
    run([
      "set -eu;",
      REFUSE,
      'found="$(command -v claude || true)";',
      `[ "$found" = "${MACHINE_CLI_PATH}" ] || fail "\\"claude\\" in this image resolves to \\"\${found:-nothing}\\", not to Fabrica's own ${MACHINE_CLI_PATH} - either something earlier on PATH answers to that name, or ${MACHINE_CLI_DIR} is not on this image's PATH at all.";`,
      'claude --version >/dev/null || fail "the worker CLI installed but will not run in this image.";',
    ]),
    "",
    "# The stamp `fabrica doctor` reads to tell a current image from one",
    "# built before either input changed: the hash of this whole generated",
    "# file, which carries both pins above and the project's own file.",
    `ARG ${MACHINE_STAMP_ARG}=""`,
    `LABEL ${DOCKERFILE_STAMP_LABEL}=$${MACHINE_STAMP_ARG}`,
  ].join("\n");
}

/**
 * The Dockerfile Fabrica builds a project's machine image from: the
 * project's own `Dockerfile.inspector`, verbatim and first, then
 * `machineLayer` above.
 *
 * Verbatim and first is the whole point - the machine's box is the
 * project's own check box with one command added, so anything the
 * project declares (its toolchain, its dependency install, the user it
 * ends as) is unchanged and unreordered. The user that file leaves its
 * final stage as is restored at the end, since the layer has to switch
 * to root to install anything at all.
 *
 * `source` is where the project's file was read from, written in as a
 * comment: for a work-mode project that is a folder outside the
 * repository, and "which Dockerfile.inspector is this" is the first
 * question anyone reading the generated file asks.
 */
export function machineDockerfile(opts: {
  inspectorDockerfile: string;
  source: string;
  pins?: { node?: string | null; cli?: string | null };
}): string {
  const own = opts.inspectorDockerfile.replace(/\s*$/, "");
  const restore = finalStageUser(own);
  return [
    `# Generated by Fabrica (issue #322) - the image this project's machine`,
    `# works in. Built from ${opts.source}, with Fabrica's own layer appended.`,
    `# Not a file to edit: it is regenerated, and rebuilt, whenever either`,
    `# half changes.`,
    own,
    "",
    machineLayer(opts.pins ?? {}),
    ...(restore === null ? [] : ["", "# Back to the user this project's own Dockerfile.inspector ends as.", `USER ${restore}`]),
    "",
  ].join("\n");
}
