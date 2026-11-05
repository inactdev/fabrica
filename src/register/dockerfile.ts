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
import { buildSecretsFor } from "../buildsecrets/index.ts";
// The one declaration of the name a `COPY --from=` here and the
// `--build-context` flag `src/projectimage/` passes both have to spell
// the same way - see that constant's own comment.
import { REPO_BUILD_CONTEXT } from "../inspector/index.ts";
import { CHECK_SCRIPT, INSPECTOR_CONFIG } from "./origin.ts";

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
 *
 * Everything a service needs happens at **check time**, in `check.sh`,
 * and nothing but installing its packages happens at build time. That
 * is issue #337's finding, and it is not a style preference: Inspector
 * runs the check as the uid of whoever invoked it (`docker run --user
 * <uid>:<gid>`, its own `internal/container/user.go`), which is not the
 * user the image was built as and has no `/etc/passwd` entry at all. So
 * anything created at build time is owned by the wrong user, and
 * PostgreSQL in particular refuses a data directory it does not own.
 * The check-time uid is unknowable while the image is being built, and
 * handing state over afterwards would need a root the check does not
 * have.
 */
export interface BoxService {
  /** How the file and the notes name it. */
  label: string;
  /** The Debian packages that install it. */
  packages: readonly string[];
  /**
   * `check.sh`: the shell lines, in order, that prepare this server's
   * own state under `$FABRICA_STATE` and start it. Lines, not one
   * command, because preparing a server to run as an arbitrary uid is
   * more than one step - and comments among them, because the next
   * person to read this file will not have been here.
   */
  start: readonly string[];
  /** `check.sh`: argv of a command that succeeds once it answers.
   * Waited on rather than slept past - the first connection can be made
   * before the server is accepting one. */
  ready: readonly string[];
  /** `check.sh`: the shell lines that stop it again, run from the EXIT
   * trap. Each one carries its own redirection and `|| true`: the trap
   * runs even when the server was never started. */
  stop: readonly string[];
  /**
   * Whether this server looks the running uid up in `/etc/passwd` and
   * cannot work without finding it - PostgreSQL does, and the check
   * box's uid has no entry.
   *
   * One service wanting this is enough to make `check.sh` add an entry
   * for itself before any server starts, and to make
   * `Dockerfile.inspector` leave `/etc/passwd` writable so it can. See
   * `userEntryPreamble` in `scaffold.ts` for the whole mechanism.
   */
  needsUserEntry?: boolean;
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
  /** What the manifest names that the repository itself supplies, each
   * copied to its own relative path under `/deps` rather than flattened
   * in beside the manifest - a `path:` gem's directory is the case that
   * found this. Separate from `extraCopies` because each one needs a
   * `COPY` of its own: a `COPY` with several sources puts them all in
   * one destination directory. */
  pathCopies?: readonly GemfileReference[];
  /** Servers `check.sh` starts inside the box, waits for, and stops
   * again, since the box has no network to reach one over. */
  services?: readonly BoxService[];
  /**
   * Credential variables the install step itself needs, mounted on it as
   * Docker build secrets (issue #342) - a paid gem source's own, derived
   * from the lockfile by `src/buildsecrets/derive.ts`. Names only: the
   * value never appears in this file, in the image, or in anything
   * Fabrica writes.
   *
   * Empty (and absent) for every project whose dependencies all come
   * from a public source, which is almost every project.
   */
  buildSecrets?: readonly string[];
  /**
   * What the lockfile named that a credential variable could *not* be
   * derived for - a gem source with a port in it, say. Written into
   * `fabrica register`'s own notes rather than dropped: a missing name
   * is a build that fails at the install step with nothing said about
   * what it was missing.
   */
  buildSecretNotes?: readonly string[];
  /** Environment this shape's suite needs exported before it runs, and
   * the reason, written into `check.sh` above it. Implies a scratch
   * directory, the same way `services` and `prepare` do. */
  runtimeEnv?: ShapeStep;
  /** One step `check.sh` runs after the services answer and before the
   * suite - the test database. */
  prepare?: ShapeStep;
}

/**
 * Whether `check.sh` needs a writable scratch directory of its own for
 * this shape - which is whenever anything in it writes at all. Nothing
 * may write inside the checkout: Inspector mounts every top-level path
 * the repository tracks read-only, and a read-only mount covers its
 * whole subtree, so a new file in a tracked directory fails exactly as
 * a modified one does (issue #337).
 */
export function needsScratchDir(shape: DependencyShape | null): boolean {
  if (shape === null) return false;
  return (shape.services ?? []).length > 0 || shape.runtimeEnv !== undefined || shape.prepare !== undefined;
}

/** The variable `check.sh` keeps that directory's path in. One name,
 * used by the script that makes it and by every service line that
 * writes under it. */
export const SCRATCH_DIR_VAR = "FABRICA_STATE";

/** The two files the check box's own uid has to appear in before
 * anything that looks a user up can run. Named in one place because
 * `Dockerfile.inspector` has to leave them writable and `check.sh` has
 * to write them. */
export const PASSWD_FILE = "/etc/passwd";
/** @see PASSWD_FILE */
export const GROUP_FILE = "/etc/group";

/** The name `check.sh` gives the uid it adds an entry for. Not an
 * account and never logged into - something for `getpwuid` to find. */
export const USER_ENTRY_NAME = "fabrica";

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

/**
 * One thing the `Gemfile` names that lives in the repository itself, and
 * so has to be copied into `/deps` before `bundle install` reads it.
 *
 * `source` is kept exactly as the Gemfile spells it, because that is
 * what bundler will look for: a relative path in a Gemfile resolves
 * against **the directory holding the Gemfile**, which at build time is
 * `/deps`. So `path: "engines/prototypes"` has to be at
 * `/deps/engines/prototypes`, not flattened into `/deps` beside the
 * manifest.
 */
export interface GemfileReference {
  /** The directive that named it, written into the Dockerfile's own
   * comment so the next reader knows which line to look at. */
  directive: "path" | "eval_gemfile" | "gemspec";
  /** What to copy, relative to the repository root, as the Gemfile
   * spells it. A directory for `path:`, a file for `eval_gemfile`, and
   * `*.gemspec` for a bare `gemspec`. */
  source: string;
  /** Where it lands - the same relative path under `/deps`. A directory
   * `COPY` copies the directory's *contents*, so a directory's
   * destination is its own path; a file's is the directory holding it.
   */
  dest: string;
}

/** Whether a `path:` value is one a `COPY` can honestly reproduce.
 * Docker strips parent-directory navigation from a source path, so
 * `../sibling` would copy something else entirely rather than fail -
 * and `.` is the whole repository. Both are named in the file instead of
 * copied (see `pathCopyLines`). */
function copyableRepoPath(path: string): boolean {
  if (path.startsWith("/") || path === "." || path === "") return false;
  return !path.split("/").includes("..");
}

/** The `Gemfile` with its comments removed, so a `#`-commented-out
 * `path:` gem is not copied and a sentence mentioning one is not
 * mistaken for a directive. Quotes are tracked, since a `#` inside a
 * string is not a comment. */
function withoutComments(gemfile: string): string {
  return gemfile
    .split("\n")
    .map((line) => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i += 1) {
        const char = line[i];
        if (quote !== null) {
          if (char === `\\`) i += 1;
          else if (char === quote) quote = null;
        } else if (char === `"` || char === `'`) quote = char;
        else if (char === `#`) return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

/** `path: "x"` and the older `:path => "x"`, which are the same option. */
const PATH_OPTION = /(?:\bpath:\s*|:path\s*=>\s*)(['"])([^'"]+)\1/g;
/** The same pattern without `g`, for asking a single line whether it
 * carries the option. A `g` regexp's `test` moves its own `lastIndex`,
 * which makes the answer depend on the previous question. */
const HAS_PATH_OPTION = new RegExp(PATH_OPTION.source);
/** `eval_gemfile "x"`, with or without parentheses. */
const EVAL_GEMFILE = /\beval_gemfile\s*\(?\s*(['"])([^'"]+)\1/g;
/** A `gemspec` directive and whatever options follow it on the line. */
const GEMSPEC_DIRECTIVE = /^[ \t]*gemspec\b(.*)$/gm;

/**
 * Everything a `Gemfile` names that `bundle install` will read out of
 * the repository, in the order the file names it and with duplicates
 * dropped.
 *
 * Three directives, because three can point at a file the repository
 * supplies: a `path:` gem, an `eval_gemfile`, and a `gemspec`. A
 * `gemspec` carrying `path:` needs nothing of its own - the `path:` rule
 * already copies the directory its gemspec is inside - and neither does
 * a `gemspec name:`, since the `*.gemspec` a bare one copies is a
 * superset of whichever file `name:` meant.
 *
 * One limit, and it fails loudly rather than quietly: a `path:` gem
 * named *inside* an `eval_gemfile`'d file is not followed. The file
 * itself is copied, bundler then evaluates it, and a path it names that
 * is not there stops the image build by name.
 */
export function gemfileReferences(gemfile: string): GemfileReference[] {
  const found = new Map<string, GemfileReference>();
  const text = withoutComments(gemfile);

  const add = (reference: GemfileReference): void => {
    if (!found.has(reference.source)) found.set(reference.source, reference);
  };

  for (const match of text.matchAll(PATH_OPTION)) {
    add({ directive: "path", source: match[2], dest: `${DEPS_DIR}/${match[2]}/` });
  }
  for (const match of text.matchAll(EVAL_GEMFILE)) {
    add({ directive: "eval_gemfile", source: match[2], dest: holdingDirectory(match[2]) });
  }
  for (const match of text.matchAll(GEMSPEC_DIRECTIVE)) {
    // A `path:` on this line was already read above, and the directory
    // it named carries the gemspec with it.
    if (HAS_PATH_OPTION.test(match[1])) continue;
    add({ directive: "gemspec", source: `*.gemspec`, dest: `${DEPS_DIR}/` });
  }

  return [...found.values()];
}

/** Where under `/deps` a *file* at this repository-relative path has to
 * land: the directory holding it, with the trailing slash a `COPY`
 * destination needs. */
function holdingDirectory(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? `${DEPS_DIR}/` : `${DEPS_DIR}/${path.slice(0, cut)}/`;
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

/** Where Debian keeps PostgreSQL's *server* binaries - one directory
 * per major version, and deliberately not on `PATH`: only the client
 * tools get `pg_wrapper` symlinks in `/usr/bin`, and `initdb`,
 * `postgres` and `pg_ctl` are not among them. */
const POSTGRES_LIB_DIR = "/usr/lib/postgresql";

/** The shell variable `check.sh` resolves that directory into once, and
 * calls every PostgreSQL binary through - `pg_isready` included.
 * `/usr/bin/pg_isready` is `pg_wrapper`, which reads a Debian cluster's
 * own configuration to find a port, and the cluster `check.sh` creates
 * is not one of those. */
const PGBIN = "PGBIN";

const POSTGRES: BoxService = {
  label: "PostgreSQL",
  // The server, its client tools (`pg_isready` among them), and the
  // `pg` gem's own build dependency: its native extension wants
  // libpq-fe.h, which is what libpq-dev installs.
  packages: ["postgresql", "libpq-dev"],
  // initdb resolves its own effective uid to a user *name* before it
  // does anything else, and there is no flag that skips it. Without an
  // entry it stops on "could not look up effective user ID".
  needsUserEntry: true,
  start: [
    `# Debian keeps PostgreSQL's server binaries out of PATH, one`,
    `# directory per major version, so they are found here rather than`,
    `# pinned to a version this file cannot know. A box with none fails`,
    `# the check right here, naming what is missing, rather than further`,
    `# down with a connection error.`,
    `${PGBIN}=$(ls -d ${POSTGRES_LIB_DIR}/*/bin 2>/dev/null | sort -V | tail -n 1)`,
    `if [ ! -x "$${PGBIN}/initdb" ]; then`,
    `  echo "${CHECK_SCRIPT}: no PostgreSQL server binaries under ${POSTGRES_LIB_DIR} - the postgresql ` +
      `package has to be installed in ${DOCKERFILE_INSPECTOR}" >&2`,
    `  exit 1`,
    `fi`,
    ``,
    `PGDATA=$${SCRATCH_DIR_VAR}/postgres/data`,
    `PGHOST=$${SCRATCH_DIR_VAR}/postgres/socket`,
    `PGUSER=postgres`,
    `# PGUSER because libpq's own default user name comes from the uid's`,
    `# /etc/passwd entry - which above gave the name of an OS user, not`,
    `# of a role in this cluster. The role initdb creates is this one.`,
    `export PGDATA PGHOST PGUSER`,
    `mkdir -p "$PGDATA" "$PGHOST"`,
    ``,
    `# The cluster is created here, at check time, rather than baked`,
    `# into the image: Inspector runs the check as the uid of whoever`,
    `# invoked it, which is not the user this image was built as, and`,
    `# PostgreSQL refuses a data directory it does not own. One created`,
    `# here is owned by whoever is running, whoever that turns out to`,
    `# be.`,
    `#`,
    `# "trust" over the local socket, for a related reason: the default`,
    `# "peer" authentication asks the kernel which uid opened the socket`,
    `# and then wants a role of that user's name - which is the OS name`,
    `# added above, and no cluster has a role of it.`,
    `# Nothing outside this container can reach that socket: the check`,
    `# box has no network at all, and this cluster listens on no TCP`,
    `# port (-h '').`,
    `pg_as() {`,
    `  if [ "$(id -u)" = 0 ]; then`,
    `    # initdb and postgres both refuse to run as root, so under root`,
    `    # this hands the cluster to the postgres system user the`,
    `    # package created. Not a hypothetical branch: under a rootless`,
    `    # Docker daemon Inspector runs the check as root inside the`,
    `    # container's own user namespace.`,
    `    chown -R postgres:postgres "$${SCRATCH_DIR_VAR}/postgres"`,
    `    su postgres -s /bin/sh -c "$1"`,
    `  else`,
    `    sh -c "$1"`,
    `  fi`,
    `}`,
    `pg_as "'$${PGBIN}/initdb' --username='$PGUSER' --auth=trust -D '$PGDATA' > ` +
      `'$${SCRATCH_DIR_VAR}/postgres/initdb.log' 2>&1"`,
    `pg_as "'$${PGBIN}/postgres' -D '$PGDATA' -k '$PGHOST' -h '' >> ` +
      `'$${SCRATCH_DIR_VAR}/postgres/server.log' 2>&1" &`,
  ],
  ready: [`"$${PGBIN}/pg_isready"`, `-q`, `-h`, `"$PGHOST"`],
  stop: [`pg_as "'$${PGBIN}/pg_ctl' -D '$PGDATA' -m fast -w stop" >/dev/null 2>&1 || true`],
};

const REDIS: BoxService = {
  label: "Redis",
  packages: ["redis-server"],
  start: [
    `# Redis needs no privileges and no state of its own, so it runs as`,
    `# whoever the check runs as with nothing to arrange first.`,
    `# Persistence is off, and its working directory, its pidfile and`,
    `# its log are all in this run's scratch directory rather than in`,
    `# the checkout, which is read-only.`,
    `mkdir -p "$${SCRATCH_DIR_VAR}/redis"`,
    `redis-server --daemonize yes --save '' --appendonly no --dir "$${SCRATCH_DIR_VAR}/redis" ` +
      `--pidfile "$${SCRATCH_DIR_VAR}/redis/redis.pid" --logfile "$${SCRATCH_DIR_VAR}/redis/redis.log"`,
  ],
  ready: ["redis-cli", "ping"],
  stop: [`redis-cli shutdown nosave >/dev/null 2>&1 || true`],
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
  /** `Gemfile`'s own contents, or absent when it could not be read.
   * Read for one question the lockfile cannot answer: which paths in
   * the repository `bundle install` will go looking for (see
   * `gemfileReferences`). */
  gemfile?: string | null;
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
  const pathCopies =
    opts.gemfile === null || opts.gemfile === undefined ? [] : gemfileReferences(opts.gemfile);
  // Issue #342: a gem source other than the public one needs a
  // credential at install time, and the lockfile is what names the
  // sources. Derived by `src/buildsecrets/`, which owns the whole
  // concept - this file only writes the mount.
  const secrets = buildSecretsFor(opts.lockfile);

  return {
    lockfile: GEMFILE_LOCK,
    manifest: GEMFILE,
    install: "bundle install",
    linksNodeModules: false,
    ...(opts.rubyVersionFile === true ? { extraCopies: [RUBY_VERSION_FILE] } : {}),
    ...(pathCopies.length > 0 ? { pathCopies } : {}),
    ...(services.length > 0 ? { services } : {}),
    ...(secrets.names.length > 0 ? { buildSecrets: secrets.names } : {}),
    ...(secrets.notes.length > 0 ? { buildSecretNotes: secrets.notes } : {}),
    ...(opts.railsBin === true
      ? {
          // Issue #337's fourth finding, on the Rails side of it: every
          // top-level path the repository tracks is mounted read-only in
          // the check box, and `rails new` tracks both `log/` and
          // `tmp/` (through `log/.keep` and `tmp/.keep`). Of the two
          // things that write there, only one stops a boot.
          runtimeEnv: {
            note:
              `RAILS_ENV, because this is a test run and nothing below says so on its own: the test-database ` +
              `step further down boots the application to do its work, and with no RAILS_ENV set it boots in ` +
              `development - a different environment, a different database and a different set of gems from ` +
              `the one the suite then runs in. Then the two writable directories: a Rails application writes ` +
              `into log/ and tmp/, and both are read-only inside the check box. Bootsnap is the one that stops ` +
              `a boot dead when its cache directory cannot be written, and it takes an environment variable - ` +
              `so its cache, and anything else reaching for a temporary directory, go in the scratch directory ` +
              `above instead. Rails' own logger needs nothing here: it catches a log file it cannot open and ` +
              `falls back to stderr with a warning.`,
            run:
              `RAILS_ENV=test\n` +
              `BOOTSNAP_CACHE_DIR=$${SCRATCH_DIR_VAR}/bootsnap\n` +
              `TMPDIR=$${SCRATCH_DIR_VAR}/tmp\n` +
              `export RAILS_ENV BOOTSNAP_CACHE_DIR TMPDIR\n` +
              `mkdir -p "$BOOTSNAP_CACHE_DIR" "$TMPDIR"`,
          },
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
      `\`bundle install\` sees only what is copied below. The three things a Gemfile can name that live in ` +
      `the repository itself - a \`path:\` gem, an \`eval_gemfile\`, a \`gemspec\` - are copied for you, each ` +
      `at the relative path bundler resolves it against. Anything else it reads needs a COPY of its own added ` +
      `here, and so does a path named *inside* an \`eval_gemfile\`'d file, which is not followed. A committed ` +
      `\`.bundle/config\` naming a path of its own is a trap of the same kind: at check time it would point ` +
      `bundler at the checkout rather than at the gems installed here, where there is no network to install ` +
      `them again.`,
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
  /** `Gemfile`'s own contents - read for the paths in the repository
   * `bundle install` will look for, which the lockfile does not say. */
  gemfile?: string | null;
  rubyVersionFile?: boolean;
  railsBin?: boolean;
}): DependencyShape | null {
  if (present.gemfileLock !== null && present.gemfileLock !== undefined) {
    return rubyShape({
      lockfile: present.gemfileLock,
      gemfile: present.gemfile,
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
    gemfile: fileIn(dir, GEMFILE),
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

/**
 * How the install step's `COPY` reaches the repository's own manifest
 * and lockfile.
 *
 * `"build-context"` is the plain `COPY`, for terms committed in the
 * repository: the build context *is* the repository there, so those
 * files are in it.
 *
 * `"named-repo-context"` is `COPY --from=repo`, for terms in a folder
 * outside the repository (issue #337's third finding). Inspector
 * resolves the `docker build` context against the terms folder, which
 * holds no `Gemfile` and no `package-lock.json` - a plain `COPY` there
 * fails the build on a file that is not missing from the repository at
 * all, only from the folder. The repository is reachable from that
 * build as the named context above, and only that way.
 */
export type RepoFilesSource = "build-context" | "named-repo-context";

/** The `COPY` flag that reads from the repository, for a build whose own
 * context is somewhere else. Empty for the in-repository case, which
 * needs none. */
function copyFrom(source: RepoFilesSource): string {
  return source === "named-repo-context" ? `--from=${REPO_BUILD_CONTEXT} ` : ``;
}

/** The comment the named-context form needs above it - a reader meeting
 * `--from=repo` with no multi-stage build anywhere in the file would
 * otherwise have nothing to go on. */
function copyFromNote(source: RepoFilesSource): string[] {
  if (source === "build-context") return [];
  return [
    `#`,
    ...comment(
      `--from=${REPO_BUILD_CONTEXT}, not a plain COPY: this project's terms live in a folder outside the ` +
        `repository, and Inspector resolves the docker build context against that folder - which holds none of ` +
        `the files below. "${REPO_BUILD_CONTEXT}" is the named build context Inspector hands every build the ` +
        `repository under check as, and the only way to reach it from here.`
    ),
  ];
}

/**
 * The `COPY` lines for what the manifest names inside the repository -
 * a `path:` gem's directory and the two other Gemfile directives that
 * read a committed file (see `gemfileReferences`).
 *
 * One `COPY` each, rather than one carrying them all: a `COPY` with
 * several sources puts every one of them in the single destination
 * directory, and the whole point here is that each has to keep the
 * relative path the manifest resolves it against.
 *
 * A path a `COPY` cannot honestly reproduce - absolute, or climbing out
 * of the repository with `..`, which Docker silently strips - is named
 * in a comment instead of copied wrong. The install then fails on it by
 * name, which is the loud answer; a `COPY` of a path that is not the one
 * the Gemfile meant would be the quiet one.
 */
function pathCopyLines(shape: DependencyShape, user: string | null, repoFiles: RepoFilesSource): string[] {
  const references = shape.pathCopies ?? [];
  if (references.length === 0) return [];

  const copyable = references.filter((reference) => copyableRepoPath(reference.source));
  const outside = references.filter((reference) => !copyableRepoPath(reference.source));
  const chown = user === null ? `` : `--chown=${user}:${user} `;

  return [
    `#`,
    ...comment(
      `What this project's ${shape.manifest} names inside the repository itself. A relative path there ` +
        `resolves against the directory holding ${shape.manifest} - which during this build is ${DEPS_DIR} - so ` +
        `each one is copied to its own path under ${DEPS_DIR} rather than in beside the manifest. Add a line ` +
        `here for anything else \`${shape.install}\` reads out of the repository.`
    ),
    ...outside.flatMap((reference) =>
      comment(
        `Not copied: ${shape.manifest}'s ${reference.directive} names "${reference.source}", which is not a ` +
          `path inside this repository. Nothing here can reach it, and \`${shape.install}\` below will say so.`
      )
    ),
    ...copyable.map(
      (reference) => `COPY ${copyFrom(repoFiles)}${chown}${reference.source} ${reference.dest}`
    ),
  ];
}

/** Where Docker mounts a build secret by default: one file per secret
 * id, readable for the length of the one `RUN` that mounts it and in no
 * layer afterwards. Docker's own documented path, not a choice of
 * ours. */
export const SECRET_MOUNT_DIR = "/run/secrets";

/**
 * The `--mount` flags that put this project's build secrets on its
 * install step, and the shell prefix that reads each one into the
 * variable bundler looks for (issue #342).
 *
 * Two deliberate choices in the spelling, both of which a different
 * answer would get silently wrong somewhere:
 *
 *   - **The file form, never `--mount=...,env=NAME`.** The `env` option
 *     hands the value straight to the step as a variable and would need
 *     no `cat` at all, but it is a newer Dockerfile frontend feature -
 *     Docker's own documentation puts it behind a `# syntax=` pin - and
 *     some installs read this file with an older frontend. The file form
 *     works on any Docker with BuildKit, which is the only requirement
 *     either side of this has.
 *   - **`mode=0444`.** A secret mounts as mode 0400 owned by root by
 *     default, so a `cat` of it fails for any install step that does not
 *     run as root - which is exactly what a `cimg/*` base image's step
 *     does (see `knownNonRootUser`). The file exists only inside this
 *     one `RUN`, on a tmpfs, in a container with nothing else in it, and
 *     is in no layer afterwards.
 *
 * One mount per name, all on the same `RUN` as the install, because a
 * secret is readable only by the step that mounts it.
 */
export function secretMountFlags(names: readonly string[]): string {
  return names.map((name) => `--mount=type=secret,id=${name},mode=0444 `).join("");
}

/** @see secretMountFlags - the variable assignments in front of the
 * install command itself. */
export function secretReadPrefix(names: readonly string[]): string {
  return names.map((name) => `${name}="$(cat ${SECRET_MOUNT_DIR}/${name})" `).join("");
}

/** The install `RUN`, with its build secrets mounted on it when this
 * project has any. One place builds this line, so the flags, the reads
 * and the command can never drift apart. */
function installRun(shape: DependencyShape): string {
  const names = shape.buildSecrets ?? [];
  return `RUN ${secretMountFlags(names)}cd ${DEPS_DIR} && ${secretReadPrefix(names)}${shape.install}`;
}

/** The comment above an install step that mounts credentials - a reader
 * meeting `--mount=type=secret` has to know where the value comes from
 * and that nothing here holds one. */
function secretNote(shape: DependencyShape): string[] {
  const names = shape.buildSecrets ?? [];
  if (names.length === 0) return [];
  return [
    `#`,
    ...comment(
      `${names.join(", ")}: this project installs from a gem source other than the public one, so ` +
        `\`${shape.install}\` needs that source's credential - and ${GEMFILE_LOCK} is what named the source. ` +
        `${names.length === 1 ? `The name is` : `The names are`} bundler's own for it. Only the ` +
        `${names.length === 1 ? `name lives` : `names live`} here: the value is mounted as a Docker build ` +
        `secret, which is a file that exists for this one RUN and is in no image layer, and comes from ` +
        `whoever runs the build (Fabrica reads it from its own brain.env; Inspector reads it from its own ` +
        `environment, which is what ${INSPECTOR_CONFIG}'s buildSecrets list is for). A build run without ` +
        `${names.length === 1 ? `it` : `them`} fails here rather than quietly installing something else.`
    ),
  ];
}

/** The install step's own lines, with the ownership dance a non-root
 * image needs around them. `rooted` says the service lines above already
 * selected `USER root`, so the guidance about the image's default user
 * would be describing something that is no longer true. */
function installLines(
  shape: DependencyShape,
  from: string,
  rooted: boolean,
  repoFiles: RepoFilesSource
): string[] {
  const user = knownNonRootUser(from);
  const caveat = shape.buildNote === undefined ? [] : [`#`, ...comment(shape.buildNote)];
  const copy = copyFrom(repoFiles);
  const note = copyFromNote(repoFiles);
  const secrets = secretNote(shape);
  // Always between the manifest's own COPY and the install, since the
  // install is what reads them.
  const paths = pathCopyLines(shape, user, repoFiles);
  if (user !== null) {
    return [
      ...caveat,
      ...note,
      ...secrets,
      `USER root`,
      `RUN mkdir -p ${DEPS_DIR} && chown -R ${user}:${user} ${DEPS_DIR}`,
      `USER ${user}`,
      `COPY ${copy}--chown=${user}:${user} ${copiedFiles(shape)} ${DEPS_DIR}/`,
      ...paths,
      installRun(shape),
    ];
  }
  if (rooted) {
    return [
      ...caveat,
      `#`,
      ...comment(`This installs as root, which the USER root above selected.`),
      ...note,
      ...secrets,
      `COPY ${copy}${copiedFiles(shape)} ${DEPS_DIR}/`,
      ...paths,
      installRun(shape),
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
    ...note,
    ...secrets,
    `COPY ${copy}${copiedFiles(shape)} ${DEPS_DIR}/`,
    ...paths,
    installRun(shape),
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
function serviceLines(shape: DependencyShape): string[] {
  const services = shape.services ?? [];
  if (services.length === 0) return [];

  const labels = services.map((service) => service.label).join(" and ");
  const one = services.length === 1;
  const them = one ? `it` : `them`;
  const packages = services.flatMap((service) => service.packages);

  return [
    `#`,
    ...comment(
      `${labels} run inside the check box itself: it has no network, so there is no server to reach over one. ` +
        `${CHECK_SCRIPT} starts ${them}, waits until ${one ? `it` : `each`} answers, and stops ${them} again.`
    ),
    `#`,
    // Issue #337's fourth finding. What used to be here - a cluster
    // started at build time and a superuser role created in it - was
    // unusable at check time for exactly this reason, and read as
    // working right up until a real Inspector ran it.
    ...comment(
      `Only the packages, and the one chmod below them, go in here. No server is initialized and none is ` +
        `started: Inspector runs the check as ` +
        `the uid of whoever invoked it, which is not the user this image is built as and has no /etc/passwd ` +
        `entry of its own, so anything created here would be owned by the wrong user - and PostgreSQL refuses a ` +
        `data directory it does not own. ${CHECK_SCRIPT} creates what it needs, as whoever is running it.`
    ),
    `USER root`,
    `RUN apt-get update \\`,
    ` && apt-get install -y --no-install-recommends ${packages.join(" ")} \\`,
    ` && rm -rf /var/lib/apt/lists/*`,
    ...userEntryLines(services),
  ];
}

/**
 * The one thing this file does about the check box's uid, as opposed to
 * saying it cannot (issue #337).
 *
 * A server that looks the running uid up in `/etc/passwd` - PostgreSQL's
 * `initdb` resolves its own effective uid to a name before anything
 * else, with no flag that skips it - cannot run in this box at all,
 * because that uid has no entry. The entry cannot be written here: the
 * uid is whoever invokes Inspector, which is unknowable while the image
 * is being built. So the only thing the image can do is leave the file
 * writable and let `check.sh` add an entry for itself.
 *
 * What that costs, stated rather than hidden: a world-writable
 * `/etc/passwd` beside a setuid `su` is a way to become root in this
 * container. It is bounded by what the box is - no network at all, no
 * credential of any kind in it, the checkout mounted read-only, and
 * every write discarded with the container - and it buys the only shape
 * in which a database server runs there.
 */
function userEntryLines(services: readonly BoxService[]): string[] {
  if (!services.some((service) => service.needsUserEntry)) return [];
  const needing = services.filter((service) => service.needsUserEntry).map((s) => s.label);
  return [
    ``,
    ...comment(
      `${needing.join(" and ")} looks the running uid up in ${PASSWD_FILE}, and the uid Inspector runs the ` +
        `check as has no entry there. Which uid that is cannot be known here, so this leaves the two files ` +
        `writable and ${CHECK_SCRIPT} adds an entry for itself. Dropping this line does not make the check ` +
        `quietly worse: it refuses, naming this line, before it starts anything.`
    ),
    `RUN chmod a+w ${PASSWD_FILE} ${GROUP_FILE}`,
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
  /** Where the install step's `COPY` reads the repository's own manifest
   * and lockfile from. Defaults to the plain build context, which is
   * what terms committed in the repository want; a terms *folder* needs
   * `"named-repo-context"` - see `RepoFilesSource`. */
  repoFiles?: RepoFilesSource;
}): string {
  const repoFiles = opts.repoFiles ?? "build-context";
  const lines = [
    ...comment(
      `The image Inspector builds and runs this project's check in. The check container has no network, so ` +
        `everything that check needs is installed here, at build time, or already ships in the image below.`
    ),
    `#`,
    ...comment(
      `Written by \`fabrica register\`. Edit it here, ` +
        (repoFiles === "named-repo-context"
          ? `in this project's own terms folder`
          : `in the repository`) +
        `, rather than anywhere in Fabrica - Inspector rebuilds the box from this file.`
    ),
    `#`,
    ...comment(`FROM: ${opts.reason}.`),
    `FROM ${opts.from.trim()}`,
  ];

  if (opts.shape !== null) {
    const services = serviceLines(opts.shape);
    lines.push(
      ...services,
      `#`,
      ...comment(`${opts.shape.note}.`),
      ...installLines(opts.shape, opts.from, services.length > 0, repoFiles)
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
