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

import { existsSync, readFileSync } from "node:fs";
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
export const GEMFILE = "Gemfile";
export const GEMFILE_LOCK = "Gemfile.lock";
export const RUBY_VERSION_FILE = ".ruby-version";
/** A Rails application's own launcher, committed at that path by every
 * `rails new` - the one signal that says `bin/rails <task>` is a command
 * this repository actually has. */
export const RAILS_BIN = "bin/rails";

/** One step a generated file carries: the line itself, and the sentence
 * written above it saying why it is there. Nothing here is ever written
 * without its reason, since the Client edits these files later. */
export interface ShapeStep {
  /** The comment above the line, in prose. */
  note: string;
  /** The command, spelled as the file spells it. */
  run: string;
}

/**
 * A service the check box has to run **for itself**: it has no network,
 * so there is no database or cache server to reach over one, and a
 * project whose suite needs them needs them inside the same container
 * (issue #324).
 */
export interface BoxService {
  /** How the file and the notes name it. */
  label: string;
  /** The Debian packages that install it. */
  packages: readonly string[];
  /** `check.sh`: what starts it, in the background. */
  start: string;
  /** `check.sh`: argv of a command that succeeds once it answers.
   * Waited on rather than slept past - the first connection can be made
   * before the server is accepting one. */
  ready: readonly string[];
  /** `check.sh`: what stops it again on the way out. */
  stop: string;
  /** `Dockerfile.inspector`: setup run as root at build time, once the
   * packages are installed, for a service that needs any. `user` is the
   * user the check itself runs as. */
  buildSetup?: (user: string) => ShapeStep;
}

/**
 * A dependency shape `register` recognizes: a lockfile at the repository
 * root, and the install step that lockfile means. Two of them were named
 * by issue #303 itself and a third by issue #324 - anything else gets a
 * comment in the Dockerfile rather than an invented install step.
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
   * false for a module cache or a gem home that lives outside the
   * checkout. */
  linksNodeModules: boolean;
  /** One sentence for a note, a summary line or a pull request body. */
  note: string;
  /** A caveat about the install step itself, written into the Dockerfile
   * as a comment above it. The install runs with only the manifest and
   * the lockfile copied in, which is enough for the common case and not
   * for every one - the file says which rather than leaving the next
   * person to find out from a failed build. */
  buildNote?: string;
  /** Files copied into `/deps` beside the manifest and the lockfile,
   * because the install step reads them too. Empty for a shape whose
   * installer needs nothing else - a `COPY` of a file the repository may
   * not have fails the build. */
  extraCopies?: readonly string[];
  /** Servers `check.sh` starts inside the box, waits for, and stops
   * again, since the box has no network to reach one over. */
  services?: readonly BoxService[];
  /** One step `check.sh` runs after the services answer and before the
   * suite - the test database. */
  prepare?: ShapeStep;
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
  buildNote:
    `\`npm ci\` runs this project's own install lifecycle scripts (\`prepare\`, \`postinstall\`), and only the ` +
    `manifest and the lockfile copied below are in ${DEPS_DIR} when it does. If one of those scripts needs ` +
    `another file, add a COPY for it too.`,
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

/**
 * The gems a `Gemfile.lock` says are **in the bundle**. Bundler writes
 * every resolved gem as a four-space entry under a `specs:` heading (of
 * `GEM`, `GIT` or `PATH`), and that gem's own requirements six spaces
 * deeper; `DEPENDENCIES` repeats what the Gemfile asked for at two.
 *
 * Only the four-space entries are read. A deeper line says what
 * something *asked for*, not what is installed, so reading those would
 * call `pg` present because some unrelated gem happens to support
 * Postgres.
 */
export function gemsIn(lockfile: string): Set<string> {
  const names = new Set<string>();
  for (const line of lockfile.split("\n")) {
    const spec = /^ {4}(\S+) \(/.exec(line);
    if (spec !== null) names.add(spec[1]);
  }
  return names;
}

/** The gem that names a Postgres dependency. */
export const PG_GEM = "pg";
/** The gems that name a Redis one: `redis` itself, and `redis-client`,
 * which is what a current Rails cache store or Sidekiq resolves to. */
export const REDIS_GEMS: readonly string[] = ["redis", "redis-client"];
/** The gems that mean the suite is run with `rspec` rather than with
 * `bin/rails test`: `rspec-core` ships the `rspec` executable, and the
 * two wrappers that pull it in are matched too, since a lockfile written
 * from a `gem "rspec-rails"` line names all of them anyway. */
export const RSPEC_GEMS: readonly string[] = ["rspec-core", "rspec-rails", "rspec"];
/** Gems that drive a browser. Issue #324 puts system tests out of scope,
 * so these are *named* in the notes and nothing is installed for them. */
export const BROWSER_GEMS: readonly string[] = ["capybara", "selenium-webdriver", "cuprite", "webdrivers"];
/** Database gems this shape knowingly installs no server for, so a
 * repository using one is told rather than left with a check that cannot
 * connect to anything. */
export const UNSERVED_DATABASE_GEMS: readonly string[] = ["mysql2", "trilogy"];

const POSTGRES: BoxService = {
  label: "PostgreSQL",
  // The server, its client tools (`pg_isready` among them), and the
  // `pg` gem's own build dependency: its native extension wants
  // libpq-fe.h, which is what libpq-dev installs.
  packages: ["postgresql", "libpq-dev"],
  // Debian's SysV wrapper, which works in a container: `systemctl` needs
  // a systemd there is none of, and the server itself may not run as
  // root - this script su's to the postgres user for us.
  start: "service postgresql start",
  ready: ["pg_isready", "-q"],
  stop: "service postgresql stop",
  buildSetup: (user) => ({
    note:
      `PostgreSQL authenticates a connection over the local socket by asking the kernel which user opened it ` +
      `(Debian's "peer" default) and then wants a role of that name - and a Rails config/database.yml names no ` +
      `user at all, so that is whoever runs the check. The role is created here, while the server is up at ` +
      `build time; it lives in the cluster's data directory, which is part of the image.`,
    run: `service postgresql start && su postgres -c "createuser -s ${user}" && service postgresql stop`,
  }),
};

const REDIS: BoxService = {
  label: "Redis",
  packages: ["redis-server"],
  // No config file, so this is the package's default port and no
  // persistence: a check's Redis is a throwaway cache, and `--save ''`
  // keeps it from writing a snapshot into the checkout.
  start: `redis-server --daemonize yes --save ''`,
  ready: ["redis-cli", "ping"],
  stop: "redis-cli shutdown nosave",
};

/**
 * The Ruby shape (issue #324), built from the lockfile rather than
 * declared as a constant: which servers the check box needs, and whether
 * there is a test database to create, are things only this repository's
 * own `Gemfile.lock` and `bin/rails` can say.
 *
 * Gems install at build time into the image's own `GEM_HOME`
 * (`/usr/local/bundle` in the official Ruby image), which is outside the
 * checkout - so, like a Go module cache and unlike `node_modules`, there
 * is nothing for `check.sh` to link in.
 */
export function rubyShape(opts: {
  /** `Gemfile.lock`'s contents. */
  lockfile: string;
  /** Whether `.ruby-version` is at the root - a Gemfile may read its
   * `ruby` line out of that file, so it is copied in when it exists. */
  rubyVersionFile?: boolean;
  /** Whether `bin/rails` is at the root, i.e. whether `bin/rails
   * db:test:prepare` is a command this repository has. */
  railsBin?: boolean;
}): DependencyShape {
  const gems = gemsIn(opts.lockfile);
  const services: BoxService[] = [];
  if (gems.has(PG_GEM)) services.push(POSTGRES);
  if (REDIS_GEMS.some((gem) => gems.has(gem))) services.push(REDIS);

  return {
    lockfile: GEMFILE_LOCK,
    manifest: GEMFILE,
    install: "bundle install",
    linksNodeModules: false,
    ...(opts.rubyVersionFile === true ? { extraCopies: [RUBY_VERSION_FILE] } : {}),
    ...(services.length > 0 ? { services } : {}),
    ...(opts.railsBin === true
      ? {
          prepare: {
            note:
              `The test database, dropped and loaded from this repository's own schema. A Rails suite checks the ` +
              `test schema is current before it runs anything, and the box starts with an empty server, so ` +
              `there is nothing for it to find until this has run.`,
            run: `${RAILS_BIN} db:test:prepare`,
          },
        }
      : {}),
    note:
      `${GEMFILE_LOCK} at the repository root is this project's lockfile, so the check image installs exactly ` +
      `it with \`bundle install\` at build time. The gems land in the image's own GEM_HOME, outside the ` +
      `checkout, so \`bundle exec\` finds them with nothing further to do` +
      (services.length === 0
        ? ``
        : `, and ${services.map((service) => service.label).join(" and ")} ` +
          `${services.length === 1 ? `is` : `are`} installed in the box too, for ${CHECK_SCRIPT} to start`),
    buildNote:
      `\`bundle install\` sees only the files copied below, which is enough for a Gemfile that names gems and ` +
      `nothing more. One that reads another file - a \`gemspec\`, an \`eval_gemfile\`, a \`path:\` gem - needs ` +
      `a COPY for that file too. A committed \`.bundle/config\` naming a path of its own is the other half of ` +
      `the same trap: at check time it would point bundler at the checkout rather than at the gems installed ` +
      `here, where there is no network to install them again.`,
  };
}

/**
 * The shape named by which lockfiles are present.
 *
 * `Gemfile.lock` is asked first, and deliberately: a repository carrying
 * it *and* a `package-lock.json` is a Rails application with a
 * JavaScript bundler, whose suite is still the Ruby one. Between the
 * other two, `package-lock.json` wins for no deeper reason than that one
 * answer has to be picked. The Dockerfile says which it took either way,
 * and `propose.ts` names the lockfile that went uninstalled.
 */
export function dependencyShapeFrom(present: {
  packageLock: boolean;
  goSum: boolean;
  /** `Gemfile.lock`'s own contents, or `null`/absent when there is none.
   * Read in full rather than as presence alone, unlike the other two:
   * which servers the check box needs is written inside it. */
  gemfileLock?: string | null;
  rubyVersionFile?: boolean;
  railsBin?: boolean;
}): DependencyShape | null {
  if (present.gemfileLock !== null && present.gemfileLock !== undefined) {
    return rubyShape({
      lockfile: present.gemfileLock,
      rubyVersionFile: present.rubyVersionFile,
      railsBin: present.railsBin,
    });
  }
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
    gemfileLock: fileIn(dir, GEMFILE_LOCK),
    rubyVersionFile: existsSync(join(dir, RUBY_VERSION_FILE)),
    railsBin: existsSync(join(dir, RAILS_BIN)),
  });
}

/** A file's contents, or null when it isn't there - the filesystem's own
 * answer in one call, rather than an `existsSync` that a read could race.
 */
function fileIn(dir: string, name: string): string | null {
  try {
    return readFileSync(join(dir, name), "utf8");
  } catch {
    return null;
  }
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

/** How long `check.sh` waits for a service to answer before failing the
 * check with a line naming which one did not. Long enough for a cold
 * Postgres cluster on a loaded machine, short enough that a server that
 * is never coming up does not burn the whole check timeout. */
export const SERVICE_WAIT_SECONDS = 60;

/** Wraps a sentence as `#` comment lines, at 76 columns - for the two
 * generated files a human reads and edits later (this one and
 * `check.sh`, see scaffold.ts). */
export function comment(text: string): string[] {
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

/** Everything the install step copies into `/deps`: the manifest, the
 * lockfile, and whatever else that installer reads. */
function copiedFiles(shape: DependencyShape): string {
  return [shape.manifest, shape.lockfile, ...(shape.extraCopies ?? [])].join(" ");
}

/** The install step's own lines, with the ownership dance a non-root
 * image needs around them. `rooted` says the service lines above already
 * selected `USER root`, so the guidance about the image's default user
 * would be describing something that is no longer true. */
function installLines(shape: DependencyShape, from: string, rooted: boolean): string[] {
  const user = knownNonRootUser(from);
  const caveat = shape.buildNote === undefined ? [] : [`#`, ...comment(shape.buildNote)];
  if (user !== null) {
    return [
      ...caveat,
      `USER root`,
      `RUN mkdir -p ${DEPS_DIR} && chown -R ${user}:${user} ${DEPS_DIR}`,
      `USER ${user}`,
      `COPY --chown=${user}:${user} ${copiedFiles(shape)} ${DEPS_DIR}/`,
      `RUN cd ${DEPS_DIR} && ${shape.install}`,
    ];
  }
  if (rooted) {
    return [
      ...caveat,
      `#`,
      ...comment(`This installs as root, which the USER root above selected.`),
      `COPY ${copiedFiles(shape)} ${DEPS_DIR}/`,
      `RUN cd ${DEPS_DIR} && ${shape.install}`,
    ];
  }
  return [
    ...caveat,
    ...comment(
      `This installs as the image's own default user, assuming that user may write ${DEPS_DIR} - true of a ` +
        `root-default image. An image that runs as someone else needs ${DEPS_DIR} handed to them first:`
    ),
    `#   USER root`,
    `#   RUN mkdir -p ${DEPS_DIR} && chown -R <user>:<user> ${DEPS_DIR}`,
    `#   USER <user>`,
    `COPY ${copiedFiles(shape)} ${DEPS_DIR}/`,
    `RUN cd ${DEPS_DIR} && ${shape.install}`,
  ];
}

/**
 * The lines that put a shape's own servers in the image (issue #324):
 * the packages, installed as root, and whatever setup each one needs
 * once they are there.
 *
 * Nothing here starts a server. A `RUN` is its own container, so a
 * service started in one is gone by the next line and gone again at
 * check time - `check.sh` starts them, and this file only has to make
 * them installable.
 */
function serviceLines(shape: DependencyShape, from: string): string[] {
  const services = shape.services ?? [];
  if (services.length === 0) return [];

  // The user the *check* runs as, which is who a build-time role or
  // permission has to be created for. `root` is the assumption
  // everywhere else in this file for an image this does not know, and
  // the official Ruby image is one that genuinely runs as root.
  const user = knownNonRootUser(from) ?? "root";
  const labels = services.map((service) => service.label).join(" and ");
  const one = services.length === 1;
  const them = one ? `it` : `them`;
  const packages = services.flatMap((service) => service.packages);

  const lines = [
    `#`,
    ...comment(
      `${labels} run inside the check box itself: it has no network, so there is no server to reach over one. ` +
        `${CHECK_SCRIPT} starts ${them}, waits until ${one ? `it` : `each`} answers, and stops ${them} again. ` +
        `Starting ${them} needs this box to run as root, which the image above does.`
    ),
    `USER root`,
    `RUN apt-get update \\`,
    ` && apt-get install -y --no-install-recommends ${packages.join(" ")} \\`,
    ` && rm -rf /var/lib/apt/lists/*`,
  ];

  for (const service of services) {
    const setup = service.buildSetup?.(user);
    if (setup === undefined) continue;
    lines.push(`#`, ...comment(setup.note), `RUN ${setup.run}`);
  }

  return lines;
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
    const services = serviceLines(opts.shape, opts.from);
    lines.push(
      ...services,
      `#`,
      ...comment(`${opts.shape.note}.`),
      ...installLines(opts.shape, opts.from, services.length > 0)
    );
  } else {
    lines.push(
      `#`,
      ...comment(
        `Nothing in this repository said how its dependencies are installed: there is no ${PACKAGE_LOCK}, no ` +
          `${GO_SUM} and no ${GEMFILE_LOCK} at its root, so no install step was written for you.`
      ),
      ...comment(
        `Add what ./check.sh needs here - the check box has no network, so a check that fetches anything while ` +
          `it runs fails there.`
      )
    );
  }

  return `${lines.join("\n")}\n`;
}
