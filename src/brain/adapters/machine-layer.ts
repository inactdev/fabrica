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
//      to /opt/fabrica/node, which is never put on PATH, and the only
//      new command in the box is a one-line launcher at
//      /usr/local/bin/claude that execs - by absolute path - exactly
//      what npm installed under /opt/fabrica. Prepending Fabrica's Node
//      to PATH would make a Node project's check run on Fabrica's
//      version in the machine's box and on its own in Inspector's - the
//      very divergence this issue removes, one layer down. The launcher
//      does not put it on PATH for its own process either: the worker's
//      shell tool spawns the project's own commands as children of that
//      process, so a PATH set there would reach the project's check
//      anyway, by a longer route.
//   2. **It fails the build loudly, naming the fix, for anything it
//      needs and cannot install.** A project image can be based on
//      anything, so there is no package manager this can assume: no
//      bash (the CLI's own Bash tool requires a real one - issue #89,
//      verified live), no git (the read-only `.git` mount is useless
//      without it), no downloader, no checksum tool, an architecture or
//      a libc Node publishes no build for. A silent skip would hand the
//      Client a box that cannot run a single command.
//
// **Why the launcher names no interpreter** (the defect that made every
// per-project image unbuildable the first time this landed - PR #323,
// reverted in #327): at the pinned version the published package is not
// a JavaScript CLI at all. Its `bin` is a small no-shebang stub, and its
// own `postinstall` replaces that stub with a self-contained *native*
// executable taken from a platform-specific optional dependency - after
// which, in the installer's own words, the command "execs the native
// binary directly - no Node.js process stays resident". The first
// version of this layer wrote a launcher that ran that file through
// Fabrica's Node, which is Node being asked to parse an executable as
// JavaScript, so nothing in any project's image could run. Verified here
// rather than reasoned about: the installed command reports its version
// with no node anywhere on PATH, and fails under one.
//
// Node is still installed, and still needed - it is what runs npm, so
// the install happens on the version this layer brought rather than on
// whatever the project's image happens to carry (or nothing at all).
// Which is also why the install passes `--include=optional` and
// `--ignore-scripts=false` explicitly: those are the two settings the
// package's own stub names as the ways it ends up installed but inert,
// and either of them can arrive from a base image's npmrc or environment
// rather than from this line.
//
// Both version pins stay in src/brain/adapters/docker/Dockerfile - the
// one place they have always lived - and are read out of it here rather
// than copied: the Node version from its `node:<x.y.z>-alpine` base tag
// and the CLI version from its `npm install -g` line.
// src/cli/node-version-pins.test.ts binds the first to `.node-version`
// alongside the other four declarations.

import { execFileSync } from "node:child_process";
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

/** The command npm itself installs, inside Fabrica's own prefix - what
 * the launcher at `MACHINE_CLI_PATH` execs. npm's global bin link,
 * never a path guessed at inside the package: what that link points at
 * is npm's business, and it has changed shape once already (see this
 * file's header). */
export const MACHINE_CLI_INSTALLED = `${MACHINE_NODE_DIR}/bin/claude`;

/** The launcher written at `MACHINE_CLI_PATH`, line by line.
 *
 * It execs the installed command by absolute path and changes nothing
 * else: no interpreter (there is none to name - see this file's header)
 * and no PATH (Fabrica's own Node must not reach anything the worker
 * runs). `"$@"` is forwarded quoted, so a task's arguments survive
 * whatever is in them. */
export const MACHINE_LAUNCHER_LINES: readonly string[] = [
  "#!/bin/sh",
  `# The Fabrica worker CLI, installed under ${MACHINE_NODE_DIR} and`,
  "# reached from here. Generated - see machine-layer.ts in Fabrica.",
  `exec "${MACHINE_CLI_INSTALLED}" "$@"`,
];

/** The launcher as one `printf` format string, single-quoted in the
 * shell so every `$` in it stays literal.
 *
 * Refuses rather than emitting a file it would get wrong: a `%` would be
 * read as a conversion, a `'` would close the quoting, and a `\` would
 * be read as an escape. None of the lines above has one, and this is
 * what keeps that true after an edit. */
export function machineLauncherPrintf(lines: readonly string[] = MACHINE_LAUNCHER_LINES): string {
  for (const line of lines) {
    const bad = ["%", "'", "\\"].filter((char) => line.includes(char));
    if (bad.length > 0) {
      throw new Error(
        `the machine launcher line ${JSON.stringify(line)} contains ${bad.join(" and ")}, which printf or the ` +
          `shell would read rather than write - rewrite the line without it.`
      );
    }
  }
  return `printf '${lines.map((line) => `${line}\\n`).join("")}'`;
}

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

/** Every `FROM` in a Dockerfile, in order: what it builds on, and the
 * name it gives the stage if it names one. */
function stagesOf(dockerfile: string): { ref: string; alias: string | null }[] {
  const stages: { ref: string; alias: string | null }[] = [];
  for (const raw of dockerfile.split("\n")) {
    // Flags (`--platform=`, `--chmod=`) are dropped rather than parsed:
    // what is wanted is the one positional argument after them.
    const from = /^FROM\s+(.*)$/i.exec(raw.trim());
    if (from === null) continue;
    const tokens = from[1].split(/\s+/).filter((token) => token.length > 0 && !token.startsWith("--"));
    if (tokens.length === 0) continue;
    const as = tokens.findIndex((token) => /^as$/i.test(token));
    stages.push({ ref: tokens[0], alias: as === -1 ? null : (tokens[as + 1] ?? null) });
  }
  return stages;
}

/**
 * The image a Dockerfile's final stage is ultimately built on - the one
 * whose own configuration decides what the built image runs as when no
 * `USER` line says.
 *
 * An *earlier* stage of the same file, named or numbered, is followed
 * back to what *it* was built on, since the question is always about a
 * real image on a registry. Only earlier ones: a stage can no more be
 * built on a later stage than on itself, so a reference matching
 * neither an earlier alias nor an earlier index is an image's name -
 * which also makes this walk strictly backwards, and so terminating.
 *
 * Null when the answer is not in the text at all: a reference carrying
 * a `$` (a build argument, whose value belongs to the build rather than
 * to the file), or a file with no `FROM`. Null is never treated as
 * "root" - `machineRestoreUser` refuses on it.
 */
export function finalStageBaseImage(dockerfile: string): string | null {
  const stages = stagesOf(dockerfile);
  if (stages.length === 0) return null;
  let index = stages.length - 1;
  for (;;) {
    const { ref } = stages[index];
    if (ref.includes("$")) return null;
    const named = stages.findIndex((stage, at) => at < index && stage.alias?.toLowerCase() === ref.toLowerCase());
    const numbered = /^\d+$/.test(ref) && Number(ref) < index ? Number(ref) : -1;
    const next = named === -1 ? numbered : named;
    if (next === -1) return ref;
    index = next;
  }
}

/** How long a base image's pull may take before the probe below gives
 * up. These are multi-gigabyte images on whatever connection the machine
 * has; the timeout is there so a stalled pull eventually reports rather
 * than hangs a `fabrica doctor` forever. */
const PULL_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The user an image's own configuration says it runs as - empty string
 * for one that names none, which means root. Null only when the question
 * could not be asked at all.
 *
 * Why this exists: a base image's user is set *inside the image*, by no
 * line of any Dockerfile that builds on it. `cimg/go` runs as `circleci`
 * and says so nowhere a reader of text could find it.
 *
 * `docker image inspect` asks the local daemon and never pulls, so a
 * base image that is not on this machine yet is pulled here first - a
 * first `fabrica doctor` on a new project, or a fresh CI runner. Said on
 * stderr before it starts, because the alternative is minutes of
 * silence that read as a hang.
 */
export function imageConfigUser(image: string): string | null {
  // `FROM scratch` is not an image and cannot be inspected. It carries
  // no configuration of any kind, so it runs as root.
  if (image.toLowerCase() === "scratch") return "";
  const read = (): string | null => {
    try {
      const out = execFileSync("docker", ["image", "inspect", image, "--format", "{{.Config.User}}"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      // The same reading `readImageStamp` takes of a template that
      // resolved to nothing, for the same reason: an image whose config
      // names no user is a real answer, not a failure.
      return out === "<no value>" || out === "<nil>" ? "" : out;
    } catch {
      return null;
    }
  };

  const local = read();
  if (local !== null) return local;
  process.stderr.write(
    `fabrica: pulling ${image} to read which user it runs as - that is in the image's own configuration, not in ` +
      `any Dockerfile line. Once per base image on this machine.\n`
  );
  try {
    execFileSync("docker", ["pull", image], { stdio: ["ignore", "ignore", "inherit"], timeout: PULL_TIMEOUT_MS });
  } catch {
    return null;
  }
  return read();
}

/** Reads what an image's own configuration says it runs as. Replaced in
 * a test, so no test has to reach a real daemon to find out what a real
 * base image does. */
export type BaseUserProbe = (image: string) => string | null;

/**
 * The user the generated image has to end as, since Fabrica's layer
 * switches to root to install and has to switch back.
 *
 * Two steps, and both are needed: the project's own final stage when it
 * names a `USER`, and otherwise the base image's own configured user -
 * which is a fact about the image, not about the text (see
 * `imageConfigUser`). Null means root, and only an empty configured user
 * means that.
 *
 * Throws, naming the fix, when the question cannot be answered: a user
 * guessed wrong here hands the Client a box running as somebody its
 * project's checks were never meant to run as. Both messages are
 * written to be read after "its Dockerfile.inspector cannot be read:",
 * which is the one sentence every caller puts them in.
 */
export function machineRestoreUser(dockerfile: string, baseUser: BaseUserProbe = imageConfigUser): string | null {
  const named = finalStageUser(dockerfile);
  if (named !== null) return named;

  const base = finalStageBaseImage(dockerfile);
  if (base === null) {
    throw new Error(
      `it names no USER at the end of its final stage, and which image that stage is built FROM cannot be read out ` +
        `of it either (a FROM naming a build argument, or no FROM at all) - so the user Fabrica's layer has to ` +
        `switch back to after installing cannot be worked out. Name it with a USER line at the end of that file.`
    );
  }
  const configured = baseUser(base);
  if (configured === null) {
    throw new Error(
      `it names no USER at the end of its final stage, so the user Fabrica's layer has to switch back to after ` +
        `installing is the one ${base} itself runs as - and that could not be read ` +
        `(\`docker image inspect ${base} --format "{{.Config.User}}"\` failed, and so did pulling it). Make sure ` +
        `Docker is running and that image can be pulled, or name the user explicitly with a USER line at the end ` +
        `of that file.`
    );
  }
  return configured === "" ? null : configured;
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
    "# pins, installed with the Node above - so npm, and the package's own",
    "# postinstall, run on the version this layer brought rather than on",
    "# whatever the project's image carries - and then reached through a",
    "# one-line launcher that execs it by absolute path, naming no",
    "# interpreter and touching no PATH. See machine-layer.ts's header for",
    "# why naming one is wrong, and for what the two explicit npm settings",
    "# below defend against.",
    run([
      "set -eu;",
      REFUSE,
      // Only for this build step: npm itself is reached here, and npm's
      // own `#!/usr/bin/env node` has to resolve to the Node above. The
      // image's PATH is untouched by this - a `RUN`'s exports end with
      // it.
      `export PATH="${MACHINE_NODE_DIR}/bin:$PATH";`,
      `npm install -g --prefix ${MACHINE_NODE_DIR} --include=optional --ignore-scripts=false --no-audit --no-fund ${WORKER_CLI_PACKAGE}@${cli};`,
      // The one path the launcher names, proved to exist and to be
      // runnable before anything is written that points at it - this is
      // where the install and the self-check below agree.
      `[ -x ${MACHINE_CLI_INSTALLED} ] || fail "npm installed ${WORKER_CLI_PACKAGE}@${cli} into ${MACHINE_NODE_DIR} but left no runnable ${MACHINE_CLI_INSTALLED} for ${MACHINE_CLI_PATH} to launch.";`,
      `mkdir -p ${MACHINE_CLI_DIR};`,
      `${machineLauncherPrintf()} > ${MACHINE_CLI_PATH};`,
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
 * ends as) is unchanged and unreordered. The user that stage ends as is
 * restored at the end, since the layer has to switch to root to install
 * anything at all - the project's own `USER` when it has one, and
 * otherwise the base image's own configured user, which is a fact about
 * that image rather than about this text (`machineRestoreUser`).
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
  /** Replaced in a test, so none has to reach a real daemon. */
  baseUser?: BaseUserProbe;
}): string {
  const own = opts.inspectorDockerfile.replace(/\s*$/, "");
  const named = finalStageUser(own);
  const restore = machineRestoreUser(own, opts.baseUser);
  return [
    `# Generated by Fabrica (issue #322) - the image this project's machine`,
    `# works in. Built from ${opts.source}, with Fabrica's own layer appended.`,
    `# Not a file to edit: it is regenerated, and rebuilt, whenever either`,
    `# half changes.`,
    own,
    "",
    machineLayer(opts.pins ?? {}),
    ...(restore === null
      ? []
      : [
          "",
          ...(named === null
            ? [
                `# Back to the user ${finalStageBaseImage(own)} itself runs as. That is`,
                "# in the base image's own configuration, which no line above names - so",
                "# it is read off the image rather than off this text.",
              ]
            : ["# Back to the user this project's own Dockerfile.inspector ends as."]),
          `USER ${restore}`,
        ]),
    "",
  ].join("\n");
}
