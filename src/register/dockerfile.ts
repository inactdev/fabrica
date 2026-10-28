// `Dockerfile.inspector`: the file the check box is built from, and the
// file `fabrica register` writes in place of the retired `image` key
// (inspector#47, inspector PR #64).
//
// Two facts drive everything here, and neither is a guess:
//
//   - **The check container has no network.** So a project's own
//     dependencies cannot be fetched while the check runs; they are
//     installed in this file, at build time.
//   - **Inspector puts the repository's own files in place when it runs
//     the check.** So anything installed at the checkout's own path at
//     build time is shadowed by them. Dependencies go in `/deps`
//     instead, and `check.sh` links what it finds there into a checkout
//     that has none.
//
// This repository's own `Dockerfile.inspector` and `check.sh` (PR #302)
// are the reference shape for both, and the only live, working evidence
// of them in reach.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { CHECK_SCRIPT } from "./origin.ts";

/** The file Inspector builds the check box from, at the repository root.
 * One name, used by the writer, the scaffolded `protectedPaths` list and
 * every message about it. */
export const DOCKERFILE_INSPECTOR = "Dockerfile.inspector";

/** Where a build-time install puts what it installed - never the
 * checkout's own path, which Inspector's own files take. */
export const DEPS_DIR = "/deps";

export const PACKAGE_JSON = "package.json";
export const PACKAGE_LOCK = "package-lock.json";
export const GO_MOD = "go.mod";
export const GO_SUM = "go.sum";

/**
 * A dependency shape `register` recognizes: a lockfile at the repository
 * root, and the install step that lockfile means. Two of them, both
 * named by issue #303 itself - anything else gets a comment in the
 * Dockerfile rather than an invented install step.
 */
export interface DependencyShape {
  /** The lockfile whose presence identified the shape. */
  lockfile: string;
  /** The manifest copied in beside it, since every installer here needs
   * both. */
  manifest: string;
  /** The install command, spelled as the Dockerfile spells it. */
  install: string;
  /** Whether `check.sh` has to link what the build installed into the
   * checkout for it to be usable at all - true for `node_modules`,
   * false for a module cache that lives outside the checkout. */
  linksNodeModules: boolean;
  /** One sentence for a note, a summary line or a pull request body. */
  note: string;
}

const NPM: DependencyShape = {
  lockfile: PACKAGE_LOCK,
  manifest: PACKAGE_JSON,
  install: "npm ci",
  linksNodeModules: true,
  note:
    `${PACKAGE_LOCK} at the repository root is this project's lockfile, so the check image installs exactly it ` +
    `with \`npm ci\` at build time, into ${DEPS_DIR}, and ${CHECK_SCRIPT} links ${DEPS_DIR}/node_modules into ` +
    `the checkout`,
};

const GO: DependencyShape = {
  lockfile: GO_SUM,
  manifest: GO_MOD,
  install: "go mod download",
  linksNodeModules: false,
  note:
    `${GO_SUM} at the repository root is this project's lockfile, so the check image fills the module cache with ` +
    `exactly it (\`go mod download\`) at build time. That cache lives in the image, outside the checkout, so ` +
    `\`go test\` finds it with nothing further to do`,
};

/** The shape named by which lockfiles are present. `package-lock.json`
 * wins a repository carrying both, for no deeper reason than that one
 * answer has to be picked and the Dockerfile says which it took. */
export function dependencyShapeFrom(present: { packageLock: boolean; goSum: boolean }): DependencyShape | null {
  if (present.packageLock) return NPM;
  if (present.goSum) return GO;
  return null;
}

/** The same question asked of a real checkout - what `register` itself
 * uses, against the temporary worktree it is about to commit. */
export function dependencyShapeInTree(dir: string): DependencyShape | null {
  return dependencyShapeFrom({
    packageLock: existsSync(join(dir, PACKAGE_LOCK)),
    goSum: existsSync(join(dir, GO_SUM)),
  });
}

/**
 * Commands that fetch a project's dependencies. Used for a warning now
 * rather than for a `network` key: a check that fetches cannot fetch at
 * all in the check box, whatever the repository declares.
 */
const DEPENDENCY_INSTALLERS: readonly RegExp[] = [
  /\bnpm\s+ci\b/,
  /\bnpm\s+(?:install|i)\b/,
  /\byarn\s+install\b/,
  /\bpnpm\s+(?:install|i)\b/,
  /\bpip3?\s+install\b/,
  /\bpoetry\s+install\b/,
  /\buv\s+sync\b/,
  /\bbundle\s+install\b/,
  /\bgo\s+mod\s+(?:download|tidy)\b/,
  /\bcargo\s+fetch\b/,
  /\bcomposer\s+install\b/,
  /\bmix\s+deps\.get\b/,
];

/** The installing command `text` actually names, spelled as it spells it
 * - quoting a label back at the Client ("npm install" for a check that
 * says `npm i`) would be describing something his repository does not
 * say. */
export function dependencyInstallerIn(text: string): string | null {
  for (const pattern of DEPENDENCY_INSTALLERS) {
    const match = pattern.exec(text);
    if (match !== null) return match[0].replace(/\s+/g, " ");
  }
  return null;
}

/**
 * The non-root user an image family is known to run as, or `null` for
 * "assume root".
 *
 * One entry, because there is live evidence for exactly one: `cimg/*`
 * images run as `circleci`, which is why this repository's own
 * `Dockerfile.inspector` has to hand `/deps` to that user before
 * installing into it. A user name is never guessed from anything else -
 * an image that runs as someone this does not know about gets a comment
 * naming exactly what to add, which is a loud gap rather than a silent
 * one.
 */
export function knownNonRootUser(from: string): string | null {
  return /^cimg\//.test(from.trim()) ? "circleci" : null;
}

/** Wraps a sentence as Dockerfile comment lines, at 76 columns. */
function comment(text: string): string[] {
  const lines: string[] = [];
  let line = "#";
  for (const word of text.split(/\s+/).filter((w) => w.length > 0)) {
    if (line === "#") line = `# ${word}`;
    else if (`${line} ${word}`.length <= 76) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = `# ${word}`;
    }
  }
  if (line !== "#") lines.push(line);
  return lines;
}

/** The install step's own lines, with the ownership dance a non-root
 * image needs around them. */
function installLines(shape: DependencyShape, from: string): string[] {
  const user = knownNonRootUser(from);
  if (user !== null) {
    return [
      `USER root`,
      `RUN mkdir -p ${DEPS_DIR} && chown -R ${user}:${user} ${DEPS_DIR}`,
      `USER ${user}`,
      `COPY --chown=${user}:${user} ${shape.manifest} ${shape.lockfile} ${DEPS_DIR}/`,
      `RUN cd ${DEPS_DIR} && ${shape.install}`,
    ];
  }
  return [
    ...comment(
      `This installs as the image's own default user, assuming that user may write ${DEPS_DIR} - true of a ` +
        `root-default image. An image that runs as someone else needs ${DEPS_DIR} handed to them first:`
    ),
    `#   USER root`,
    `#   RUN mkdir -p ${DEPS_DIR} && chown -R <user>:<user> ${DEPS_DIR}`,
    `#   USER <user>`,
    `COPY ${shape.manifest} ${shape.lockfile} ${DEPS_DIR}/`,
    `RUN cd ${DEPS_DIR} && ${shape.install}`,
  ];
}

/**
 * `Dockerfile.inspector`'s contents. `from` is the image - `--image`, or
 * the one a proposal derived - and `reason` is where that image came
 * from, written as the file's own comment since a Dockerfile has
 * somewhere to put one and `.inspector.json` never did.
 *
 * A shape of `null` is the one case that must not pass quietly: the file
 * says, in its own words, that nothing here recognized how this
 * project's dependencies are installed and that the check box has no
 * network to install them at run time.
 */
export function inspectorDockerfile(opts: {
  from: string;
  reason: string;
  shape: DependencyShape | null;
}): string {
  const lines = [
    ...comment(
      `The image Inspector builds and runs ./check.sh in. The check container has no network, so everything ` +
        `that check needs is installed here, at build time, or already ships in the image below.`
    ),
    `#`,
    ...comment(
      `Written by \`fabrica register\`. Edit it here, in the repository, rather than anywhere in Fabrica - ` +
        `Inspector rebuilds the box from this file.`
    ),
    `#`,
    ...comment(`FROM: ${opts.reason}.`),
    `FROM ${opts.from.trim()}`,
  ];

  if (opts.shape !== null) {
    lines.push(
      `#`,
      ...comment(`${opts.shape.note}.`),
      ...installLines(opts.shape, opts.from)
    );
  } else {
    lines.push(
      `#`,
      ...comment(
        `Nothing in this repository said how its dependencies are installed: there is no ${PACKAGE_LOCK} and no ` +
          `${GO_SUM} at its root, so no install step was written for you. Add what ./check.sh needs here - the ` +
          `check box has no network, so a check that fetches anything while it runs fails there.`
      )
    );
  }

  return `${lines.join("\n")}\n`;
}
