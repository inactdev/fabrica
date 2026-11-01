// Proposing an `.inspector.json` for a repository that has none
// (issue #114): Fabrica derives one from what the repository already
// says, prints it, and never writes it.
//
// The "never writes it" half is the point, not a limitation. A tool that
// quietly writes the file defining how its own work is judged is the
// off-the-books edit this project exists to prevent, so the proposal
// leaves the Client holding the pen: the document goes to stdout alone -
// pipeable straight into `.inspector.json` - and every field's reasoning
// goes to stderr, one line per field, because JSON has nowhere to put a
// comment (Client ruling, issue #114's clarification).
//
// Since inspector#47 the proposal is two files, not one: the config no
// longer names an image or a network, so the `Dockerfile.inspector` the
// check box is built from is proposed alongside it (dockerfile.ts). It
// rides on stderr with the reasoning rather than on stdout, which stays
// the single document the redirect writes.
//
// Deterministic parsing only, no machine (same ruling). The signals are
// read from **origin's default branch** rather than the Client's working
// tree - the same ref the "does this repository have .inspector.json"
// question was just asked against, and the ref a task's base commit is
// actually cut from (src/line/cut.ts):
//
//   - an existing `check.sh`, which wins every disagreement
//   - `package.json`'s `scripts`, `engines` and declared dependencies
//   - `go.mod`
//   - `Gemfile.lock` (contents), `Gemfile`, `.ruby-version` and whether
//     `bin/rails` is there - issue #324's Ruby shape, which is the one
//     that reads a lockfile's contents, since what the check box has to
//     run (Postgres, Redis) is written inside it
//   - whether `package-lock.json` or `go.sum` is there, which decides
//     the install step the Dockerfile gets
//
// Reading is one function; deriving is a pure one over what it read, so
// every rule below is testable with no git and no repository.

import { CHECK_SCRIPT, INSPECTOR_CONFIG, RECORDED_CHECK, fileExistsOnRef, readFileOnRef } from "./origin.ts";
import { checkScript, inspectorConfigJson } from "./scaffold.ts";
import {
  BROWSER_GEMS,
  DEPS_DIR,
  DOCKERFILE_INSPECTOR,
  GEMFILE,
  GEMFILE_LOCK,
  GO_MOD,
  GO_SUM,
  PACKAGE_JSON,
  PACKAGE_LOCK,
  RAILS_BIN,
  RSPEC_GEMS,
  RUBY_VERSION_FILE,
  UNSERVED_DATABASE_GEMS,
  dependencyInstallerIn,
  dependencyShapeFrom,
  gemsIn,
  inspectorDockerfile,
  type DependencyShape,
} from "./dockerfile.ts";

// Re-exported rather than declared again: the filenames a proposal reads
// and the filenames the Dockerfile writer copies have to be the same
// strings, by construction.
export { GEMFILE, GEMFILE_LOCK, GO_MOD, PACKAGE_JSON, RUBY_VERSION_FILE };

/**
 * A marker value, never a guess. Uppercase on purpose: a Docker
 * repository name must be lowercase, so this is an *invalid* reference -
 * a proposal committed without being read fails loudly on the first
 * build instead of silently resolving to something plausible.
 * (`register`'s own proving run pulls the image `--image` names and
 * refuses on a bad one, which is the backstop on that route.)
 */
export const IMAGE_PLACEHOLDER_PREFIX = "REPLACE-ME-with-";

/**
 * `timeoutSeconds` for a check that boots its own servers, loads a
 * schema and runs a Rails suite: 30 minutes, by Client ruling on issue
 * #324 ("the usual, with a longer default timeout"). Every other shape
 * still writes no timeout at all - see `proposeTimeout`.
 */
export const RUBY_TIMEOUT_SECONDS = 30 * 60;

/** The things a repository is read for. `null` means the file isn't on
 * the branch at all; `package-lock.json` and `go.sum` are read as
 * presence alone, since nothing here cares what is inside one (and one
 * of them is routinely a megabyte) - `Gemfile.lock` is the exception and
 * says why on its own field. */
export interface ProposalSignals {
  /** `check.sh` at the repository root. */
  checkScript: string | null;
  /** `package.json` at the repository root, unparsed. */
  packageJson: string | null;
  /** `go.mod` at the repository root. */
  goMod: string | null;
  /** Whether `package-lock.json` is at the repository root. */
  packageLock: boolean;
  /** Whether `go.sum` is at the repository root. */
  goSum: boolean;
  /** `Gemfile.lock` at the repository root - contents, not presence,
   * unlike the two lockfiles above (issue #324): which servers the check
   * box has to run, and whether the suite is rspec's, are written inside
   * it. Bundler's lockfile is a few hundred lines even for a large
   * application, so reading it costs nothing like a `package-lock.json`
   * would. */
  gemfileLock: string | null;
  /** `Gemfile` at the repository root - read for its own `ruby` line. */
  gemfile: string | null;
  /** `.ruby-version` at the repository root. */
  rubyVersion: string | null;
  /** Whether `bin/rails` is at the repository root, i.e. whether
   * `bin/rails <task>` is a command this repository has. */
  railsBin: boolean;
}

/** What `fabrica register` prints when a repository has no
 * `.inspector.json`: two streams, deliberately separate. */
export interface InspectorProposal {
  /**
   * stdout, and the only thing on it: the document exactly as it should
   * be committed, with no trailing newline - the printer adds exactly
   * one, so `fabrica register <path> > .inspector.json` yields a file
   * ending in a single newline.
   */
  json: string;
  /**
   * The `Dockerfile.inspector` to commit next to it, since inspector#47:
   * the check box is built from that file and `.inspector.json` names no
   * image at all any more. It is deliberately **not** on stdout - that
   * stream is the one document the redirect in the notes writes, and a
   * second file there would corrupt it. It appears in `notes` instead,
   * for the Client to copy.
   */
  dockerfile: string;
  /**
   * The `check.sh` to commit beside them, for a project whose derived
   * suite only passes with a preamble around it (issue #324): the config
   * then names `./check.sh` rather than the command, so the script is
   * part of the proposal rather than left to the Client to work out.
   * `null` for every other project, where the config names the command
   * itself and what else `check.sh` should hold is his call.
   *
   * On `notes` for the same reason the Dockerfile is, and never on
   * stdout.
   */
  checkScript: string | null;
  /**
   * stderr, in order: what happened, one line per field, any
   * disagreement between signals, the files themselves, and what to do
   * next.
   */
  notes: string[];
}

/** Reads the signals off `ref` - never off the working tree. */
export function readProposalSignals(project: string, ref: string): ProposalSignals {
  return {
    checkScript: readFileOnRef(project, ref, CHECK_SCRIPT),
    packageJson: readFileOnRef(project, ref, PACKAGE_JSON),
    goMod: readFileOnRef(project, ref, GO_MOD),
    packageLock: fileExistsOnRef(project, ref, PACKAGE_LOCK),
    goSum: fileExistsOnRef(project, ref, GO_SUM),
    gemfileLock: readFileOnRef(project, ref, GEMFILE_LOCK),
    gemfile: readFileOnRef(project, ref, GEMFILE),
    rubyVersion: readFileOnRef(project, ref, RUBY_VERSION_FILE),
    railsBin: fileExistsOnRef(project, ref, RAILS_BIN),
  };
}

function parsedPackageJson(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // An unparseable package.json is not a signal, and not this
    // command's problem to report: the fields it would have fed simply
    // fall through to the next signal, and say so.
    return null;
  }
}

function stringField(holder: Record<string, unknown> | null, group: string, key: string): string | null {
  const nested = holder?.[group];
  if (typeof nested !== "object" || nested === null) return null;
  const value = (nested as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function dependencyCount(pkg: Record<string, unknown> | null): number {
  let total = 0;
  for (const group of ["dependencies", "devDependencies"]) {
    const value = pkg?.[group];
    if (typeof value === "object" && value !== null) total += Object.keys(value).length;
  }
  return total;
}

/** The Go toolchain version `go.mod`'s own `go` directive names. */
function goVersion(goMod: string | null): string | null {
  const match = goMod === null ? null : /^\s*go\s+(\d+(?:\.\d+)*)\s*$/m.exec(goMod);
  return match ? match[1] : null;
}

/** Where an exactly-pinned Ruby version was read from, for the `FROM`
 * line's own reasoning - the file is the evidence, so it is named. */
interface RubyVersion {
  version: string;
  source: string;
}

/**
 * The one Ruby version a repository pins, with the file that pins it, or
 * `null` when it names none - or names a *range*, which is no single
 * image tag (the same rule `engines.node` follows below).
 *
 * Three files can say it, asked in the order issue #324 names them:
 * `.ruby-version` first, then the Gemfile's own `ruby` line, then - last
 * - `Gemfile.lock`'s `RUBY VERSION`, which is the version bundler itself
 * recorded when the lockfile was written, with the patch level
 * (`3.3.4p63`) that belongs to a build of Ruby rather than to an image
 * tag.
 */
function rubyVersion(signals: ProposalSignals): RubyVersion | null {
  // rbenv and rvm both write a bare version; rvm's own files sometimes
  // carry a `ruby-` prefix, and a `jruby-`/`truffleruby-` one names an
  // implementation this does not have an image for, so it matches
  // nothing here and falls through to the placeholder.
  const pinned = signals.rubyVersion === null ? null : /^(?:ruby-)?v?(\d+\.\d+\.\d+)\s*$/m.exec(signals.rubyVersion);
  if (pinned !== null) return { version: pinned[1], source: RUBY_VERSION_FILE };

  const declared = signals.gemfile === null ? null : /^\s*ruby\s+["'](\d+\.\d+\.\d+)["']/m.exec(signals.gemfile);
  if (declared !== null) return { version: declared[1], source: `${GEMFILE}'s ruby line` };

  const locked =
    signals.gemfileLock === null ? null : /^RUBY VERSION\s*\n\s+ruby\s+(\d+\.\d+\.\d+)/m.exec(signals.gemfileLock);
  if (locked !== null) return { version: locked[1], source: `${GEMFILE_LOCK}'s RUBY VERSION` };

  return null;
}

/** The gems in the bundle, or an empty set for a repository with no
 * `Gemfile.lock` - so every question below ("does it use pg?") can be
 * asked without first asking whether this is a Ruby project at all. */
function lockedGems(signals: ProposalSignals): Set<string> {
  return signals.gemfileLock === null ? new Set<string>() : gemsIn(signals.gemfileLock);
}

/** The suite command a Ruby repository's own signals name, or `null`
 * when they name none. `rspec` wins when the lockfile has it, since a
 * repository that installed rspec runs its suite with it; otherwise
 * `bin/rails test` is the command a Rails application ships
 * (issue #324: "bin/rails test or bundle exec rspec, whichever the
 * repository has"). */
function rubySuiteCommand(signals: ProposalSignals): string | null {
  const gems = lockedGems(signals);
  if (RSPEC_GEMS.some((gem) => gems.has(gem))) return "bundle exec rspec";
  if (signals.railsBin) return `${RAILS_BIN} test`;
  return null;
}

/** `check.sh`'s meaningful lines - the shebang, comments and a bare
 * `set -e` carry no command, and quoting them back at the Client as
 * "what your check runs" would be noise. */
function checkScriptBody(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && !/^set\s+-e\w*$/.test(line))
    .join("; ");
}

/**
 * Where the derived check came from. The printed proposal does not need
 * to know - it quotes `command` and stops - but a route that *writes* a
 * `check.sh` (`--terms`, see terms.ts) does: whether the repository
 * already has its own script, names a command but no script, or names
 * nothing at all decides whether a `check.sh` is written beside the
 * config and what goes in it.
 */
export type CheckSource =
  /** The repository already carries `check.sh` at its root, and an
   * existing one wins over every other signal. */
  | "repository-script"
  /** The repository names a command but no script of its own -
   * `package.json`'s `test` script, a Go module's `go test ./...`. */
  | "declared-command"
  /** Nothing in the repository names a command that has to pass. */
  | "none";

export interface CheckField {
  /** What goes in `.inspector.json`'s `check`. */
  command: string;
  /**
   * The command `check.sh` itself runs, when `command` is `./check.sh`
   * *because* the suite only works with the script's own preamble around
   * it - the Ruby shape's servers and test database (issue #324).
   * `undefined` when `command` is the command, which is every other
   * case: there, a route that writes a `check.sh` puts `command` in it.
   *
   * The distinction is load-bearing on the printed route: naming
   * `bundle exec rspec` as `.inspector.json`'s check would be naming a
   * command that runs with no database server anywhere near it.
   */
  scriptCommand?: string;
  /** The repository-relative file that command *is*, when it is one -
   * what `protectedPaths` lists. `null` for an indirect command like
   * `npm test`, where which file to freeze is the Client's call. */
  file: string | null;
  /** The text a check is searched for dependency installers in: the
   * script's own body when there is a script, the command itself
   * otherwise. */
  text: string;
  source: CheckSource;
  reason: string;
}

/**
 * `check`. An existing `check.sh` wins over every other signal (Client
 * ruling), and any signal it disagrees with is named rather than
 * silently dropped.
 *
 * `shape` is the dependency shape already derived from the same signals
 * (`proposeDependencies`), and the one thing this needs from it: whether
 * the derived command needs a preamble around it to work at all, which
 * decides whether the config can name the command or has to name
 * `./check.sh`.
 */
function proposeCheck(
  signals: ProposalSignals,
  pkg: Record<string, unknown> | null,
  shape: DependencyShape | null
): CheckField {
  if (signals.checkScript !== null) {
    const body = checkScriptBody(signals.checkScript);
    return {
      command: RECORDED_CHECK,
      file: CHECK_SCRIPT,
      text: signals.checkScript,
      source: "repository-script",
      reason:
        `the repository already has a ${CHECK_SCRIPT} at its root, and an existing one wins over every ` +
        `other signal` +
        (body.length > 0 ? `. It runs: ${body}` : ``),
    };
  }

  // Before package.json's, and deliberately: a Rails application with a
  // JavaScript bundler has both, and its suite is the Ruby one. The same
  // reasoning orders the shapes in dockerfile.ts.
  const ruby = rubySuiteCommand(signals);
  if (ruby !== null) {
    // Asked of the shape rather than of the gems again: whether there is
    // a preamble at all is one decision, made in dockerfile.ts, and two
    // readings of the same lockfile could only come to disagree.
    const needsBox = (shape?.services ?? []).length > 0 || shape?.prepare !== undefined;
    const named =
      ruby === "bundle exec rspec"
        ? `${GEMFILE_LOCK} has rspec in it, so that is how this project's suite is run`
        : `${RAILS_BIN} is a Rails application's own launcher and ${GEMFILE_LOCK} names no rspec, so the ` +
          `framework's own test command stands`;
    return needsBox
      ? {
          // The command cannot stand alone: it needs the servers started
          // and the test database created around it, and the only place
          // that preamble can live is the script.
          command: RECORDED_CHECK,
          scriptCommand: ruby,
          file: CHECK_SCRIPT,
          text: ruby,
          source: "declared-command",
          reason:
            `${named}. It is named inside ${CHECK_SCRIPT} rather than here, because it only passes with this ` +
            `project's own servers started and its test database created first - which is what the proposed ` +
            `${CHECK_SCRIPT} below does`,
        }
      : {
          command: ruby,
          file: null,
          text: ruby,
          source: "declared-command",
          reason: named,
        };
  }

  const testScript = stringField(pkg, "scripts", "test");
  if (testScript !== null) {
    return {
      command: "npm test",
      file: null,
      source: "declared-command",
      // The script's own body too, not just the `npm test` that invokes
      // it: a "test" script that starts with its own `npm ci` is a check
      // that fetches, and the warning about that has to see it.
      text: `npm test\n${testScript}`,
      reason: `${PACKAGE_JSON}'s "test" script is the only command the repository names (${testScript})`,
    };
  }

  if (signals.goMod !== null) {
    const version = goVersion(signals.goMod);
    return {
      command: "go test ./...",
      file: null,
      text: "go test ./...",
      source: "declared-command",
      reason:
        `${GO_MOD} makes this a Go module${version === null ? `` : ` (go ${version})`} and nothing in it names ` +
        `another command, so the toolchain's own test command stands`,
    };
  }

  return {
    command: RECORDED_CHECK,
    file: CHECK_SCRIPT,
    text: "",
    source: "none",
    reason:
      `nothing in the repository names a command that has to pass - no ${CHECK_SCRIPT}, no ${PACKAGE_JSON} ` +
      `"test" script, no ${GO_MOD}, no suite named by ${GEMFILE_LOCK}. Write ${CHECK_SCRIPT} with the one ` +
      `command you want held to, and this names it`,
  };
}

/** Signals the winning `check.sh` contradicts, named on stderr rather
 * than dropped. A `check.sh` that already runs the other signal's
 * command is not a disagreement. */
function checkDisagreements(signals: ProposalSignals, pkg: Record<string, unknown> | null): string[] {
  if (signals.checkScript === null) return [];
  const body = checkScriptBody(signals.checkScript);
  const notes: string[] = [];

  const testScript = stringField(pkg, "scripts", "test");
  if (testScript !== null && !/\bnpm\s+(?:test|run\s+test)\b/.test(body) && !body.includes(testScript)) {
    notes.push(
      `  disagreement: ${PACKAGE_JSON} declares a "test" script (${testScript}) that ${CHECK_SCRIPT} does not ` +
        `run. ${CHECK_SCRIPT} wins, as the file both Inspector and a worker's own box execute - this changes ` +
        `neither of them, it only says they differ.`
    );
  }
  if (signals.goMod !== null && !/\bgo\s+test\b/.test(body)) {
    notes.push(
      `  disagreement: ${GO_MOD} makes this a Go module, but ${CHECK_SCRIPT} runs no \`go test\`. ` +
        `${CHECK_SCRIPT} wins - if it should run the Go tests too, that is an edit to ${CHECK_SCRIPT}, not to ` +
        `${INSPECTOR_CONFIG}.`
    );
  }
  const ruby = rubySuiteCommand(signals);
  if (ruby !== null && !/\b(?:rspec|rails\s+test|rake)\b/.test(body)) {
    notes.push(
      `  disagreement: this repository's own signals name \`${ruby}\` as its suite, but ${CHECK_SCRIPT} runs ` +
        `neither that nor a \`rake\` that could be running it. ${CHECK_SCRIPT} wins - if it should run the Ruby ` +
        `suite too, that is an edit to ${CHECK_SCRIPT}, not to ${INSPECTOR_CONFIG}.`
    );
  }
  return notes;
}

export interface ImageField {
  value: string;
  reason: string;
}

/**
 * `Dockerfile.inspector`'s `FROM` - since inspector#47 this is a line in
 * a file register writes, not an `image` key in `.inspector.json`.
 *
 * The one declaration-to-image pairing there is live evidence for is
 * `engines.node` pinned exactly against `cimg/node:<version>` - this
 * repository's own Dockerfile.inspector, which the real Inspector builds
 * the check box from. Everything else is a placeholder rather than a
 * guess: a version *range* names no single tag, and `go.mod`'s toolchain
 * version has no in-repo precedent for a Go image at all.
 */
function proposeImage(signals: ProposalSignals, pkg: Record<string, unknown> | null): ImageField {
  // A Ruby project's own image, asked before node's: a Rails
  // application with a JavaScript bundler declares both, and the box has
  // to be the one that runs the suite. Issue #324 names the pairing -
  // the official Ruby image for the version the repository pins - and
  // the official image's tags are exactly those versions
  // (`ruby:3.3.4`), which is what makes it derivable at all.
  if (signals.gemfileLock !== null) {
    const ruby = rubyVersion(signals);
    if (ruby !== null) {
      return {
        value: `ruby:${ruby.version}`,
        reason:
          `${ruby.source} pins ruby ${ruby.version}, and \`ruby:<version>\` is the official Ruby image for ` +
          `exactly that version. Passing --image instead has \`fabrica register\` pull the tag and refuse if ` +
          `it does not exist, which is worth doing for an old patch release`,
      };
    }
    return {
      value: `${IMAGE_PLACEHOLDER_PREFIX}an-image-that-ships-this-projects-ruby`,
      reason:
        `${GEMFILE_LOCK} makes this a Ruby project, but nothing in it pins one exact Ruby version - ` +
        `${RUBY_VERSION_FILE} is absent or holds a range, and neither ${GEMFILE} nor ${GEMFILE_LOCK} names one ` +
        `either - and a range is no single image tag. Pin the version you want the check held to (an exact ` +
        `\`x.y.z\` in ${RUBY_VERSION_FILE}) and run this again, or name the image yourself. This value is ` +
        `deliberately not a valid Docker reference, so it cannot be committed by accident`,
    };
  }

  const node = stringField(pkg, "engines", "node");
  if (node !== null) {
    const exact = /^v?(\d+\.\d+\.\d+)$/.exec(node);
    if (exact !== null) {
      return {
        value: `cimg/node:${exact[1]}`,
        reason:
          `${PACKAGE_JSON}'s engines.node pins node ${exact[1]} exactly, and cimg/node:<version> is the one ` +
          `declaration-to-image pairing Fabrica has a live, working ${DOCKERFILE_INSPECTOR} for. Passing ` +
          `--image instead has \`fabrica register\` pull the tag and refuse if it does not exist, so a wrong ` +
          `guess cannot pass quietly that way`,
      };
    }
    return {
      value: `${IMAGE_PLACEHOLDER_PREFIX}an-image-that-ships-node`,
      reason:
        `${PACKAGE_JSON}'s engines.node is a range (${node}), which names no single image tag - pick the one ` +
        `node version you want the check held to. This value is deliberately not a valid Docker reference, ` +
        `so it cannot be committed by accident`,
    };
  }

  const go = goVersion(signals.goMod);
  if (go !== null) {
    return {
      value: `${IMAGE_PLACEHOLDER_PREFIX}an-image-that-ships-go-${go}`,
      reason:
        `${GO_MOD} declares go ${go}, but nothing in the repository names a container image and Fabrica has no ` +
        `verified Go image to offer - name one that already ships that toolchain. This value is deliberately ` +
        `not a valid Docker reference, so it cannot be committed by accident`,
    };
  }

  return {
    value: `${IMAGE_PLACEHOLDER_PREFIX}the-image-this-check-runs-in`,
    reason:
      `nothing in the repository says what the check runs inside, and this is the one line no signal can ` +
      `supply - name an image that already ships the toolchain the check needs. Anything this project's own ` +
      `check installs goes below the FROM line instead, at build time, since the check box has no network. ` +
      `This value is deliberately not a valid Docker reference, so it cannot be committed by accident`,
  };
}

export interface DependencyField {
  /** The install step the Dockerfile gets, or `null` for a shape nothing
   * here recognizes - which becomes a comment in the file, never a
   * silent gap. */
  shape: DependencyShape | null;
  /** What goes on the `Dockerfile.inspector dependencies:` note line. */
  summary: string;
  reason: string;
}

/**
 * The install step `Dockerfile.inspector` gets - what the retired
 * `network: true` used to stand in for. The check box has no network, so
 * fetching at check time is no longer something a key can buy: a
 * recognized lockfile becomes a real install step at build time, and
 * anything else is named in the file rather than papered over.
 */
function proposeDependencies(
  signals: ProposalSignals,
  pkg: Record<string, unknown> | null
): DependencyField {
  const shape = dependencyShapeFrom({
    packageLock: signals.packageLock,
    goSum: signals.goSum,
    gemfileLock: signals.gemfileLock,
    rubyVersionFile: signals.rubyVersion !== null,
    railsBin: signals.railsBin,
  });
  if (shape !== null) {
    return {
      shape,
      summary: `${shape.install} from ${shape.lockfile}`,
      reason: shape.note,
    };
  }

  if (signals.gemfile !== null) {
    return {
      shape: null,
      summary: "none - a comment naming what is missing",
      reason:
        `${GEMFILE} makes this a Ruby project but there is no ${GEMFILE_LOCK} at the root, so there is no ` +
        `lockfile to install exactly. The check box has no network, so install the gems in ` +
        `${DOCKERFILE_INSPECTOR} yourself (or commit ${GEMFILE_LOCK} and run this again) - the file says so ` +
        `where the step would have gone`,
    };
  }

  const declared = dependencyCount(pkg);
  if (declared > 0) {
    return {
      shape: null,
      summary: "none - a comment naming what is missing",
      reason:
        `${PACKAGE_JSON} declares ${declared} ${declared === 1 ? "dependency" : "dependencies"} but there is no ` +
        `${PACKAGE_LOCK} at the root, so there is no lockfile to install exactly. The check box has no network, ` +
        `so install them in ${DOCKERFILE_INSPECTOR} yourself (or commit the lockfile and run this again) - the ` +
        `file says so where the step would have gone`,
    };
  }
  if (signals.goMod !== null && /^\s*require\b/m.test(signals.goMod)) {
    return {
      shape: null,
      summary: "none - a comment naming what is missing",
      reason:
        `${GO_MOD} has \`require\` entries but there is no ${GO_SUM} at the root, so there is no lockfile to ` +
        `fill the module cache from. The check box has no network and starts with an empty cache, so fill it ` +
        `in ${DOCKERFILE_INSPECTOR} yourself (or commit ${GO_SUM} and run this again) - the file says so where ` +
        `the step would have gone`,
    };
  }
  return {
    shape: null,
    summary: "none",
    reason:
      `nothing in the repository declares a dependency to install - no ${PACKAGE_LOCK}, no ${GO_SUM}, no ` +
      `${GEMFILE_LOCK}, and nothing in ${PACKAGE_JSON} or ${GO_MOD} naming one. The file says so where an ` +
      `install step would have gone, since the check box has no network to get one later`,
  };
}

/**
 * `timeoutSeconds`. Almost always omitted, and the line says why:
 * nothing in a `package.json`, a `go.mod` or a `check.sh` says how long
 * a check takes, and the invented number would be the one deciding
 * whether a real check is killed mid-run.
 *
 * The Ruby shape is the one exception, and not from a signal: a check
 * that boots its own Postgres, loads a schema and runs a Rails suite is
 * in a different order of magnitude from `go test ./...`, so leaving
 * Inspector's own default to decide would be leaving a real suite to be
 * killed mid-run. 30 minutes, by Client ruling on issue #324.
 */
function proposeTimeout(dependencies: DependencyField): { seconds?: number; reason: string } {
  if (dependencies.shape?.services !== undefined && dependencies.shape.services.length > 0) {
    const labels = dependencies.shape.services.map((service) => service.label).join(" and ");
    return {
      seconds: RUBY_TIMEOUT_SECONDS,
      reason:
        `${RUBY_TIMEOUT_SECONDS} - this check starts ${labels} in the box, creates the test database and then ` +
        `runs the whole suite, which is a different order of magnitude from a check that only compiles and ` +
        `tests. Nothing in the repository says how long it actually takes, so this is a ceiling rather than a ` +
        `measurement: watch one run and set it to what you see`,
    };
  }
  return {
    reason:
      `omitted - nothing in the repository says how long the check takes, so Inspector's own default stands. ` +
      `Set it once you have watched the check run`,
  };
}

/**
 * The one trap this change creates, named rather than left to a red
 * first task: a check that installs its own dependencies cannot, in a
 * box with no network. It is a `warning:` line rather than a field's
 * reason because it is about the check itself, not about anything the
 * proposal writes.
 */
function fetchingCheckWarning(check: CheckField, dependencies: DependencyField): string | null {
  const installer = dependencyInstallerIn(check.text);
  if (installer === null) return null;
  return (
    `  warning: the check runs \`${installer}\`, which fetches this project's dependencies - and the check box ` +
    `has no network at all, so that step cannot succeed there. ` +
    (dependencies.shape === null
      ? `Install them in ${DOCKERFILE_INSPECTOR} at build time instead, and have ${CHECK_SCRIPT} use what is ` +
        `already there rather than fetching.`
      : `${DOCKERFILE_INSPECTOR} installs them at build time instead${
          dependencies.shape.linksNodeModules
            ? ` - link them in the way Fabrica's own ${CHECK_SCRIPT} does (\`[ -d ${DEPS_DIR}/node_modules ] ` +
              `&& ln -s ${DEPS_DIR}/node_modules node_modules\`) rather than fetching`
            : ``
        }.`)
  );
}

/**
 * The other half of the `/deps` mechanism, for a route that does not
 * write `check.sh` itself: a printed proposal never does, and the
 * `--terms` route does not when the repository already carries its own.
 * Either way the Client's own file has to use what the image installed.
 * `npm ci` at build
 * time lands in `/deps` rather than in the checkout - Inspector puts the
 * repository's own files in place at check time, over anything installed
 * at that path - so a `check.sh` that links nothing in runs against a
 * checkout with no `node_modules` and no network to fix it.
 *
 * Only for a shape that needs linking at all, and only when
 * `fetchingCheckWarning` is not already saying it: one instruction, in
 * one place.
 */
function linkingNote(dependencies: DependencyField, warned: boolean): string | null {
  if (warned || dependencies.shape === null || !dependencies.shape.linksNodeModules) return null;
  return (
    `  ${CHECK_SCRIPT}: whatever this check ends up running, it has to use what the image installed - ` +
    `\`${dependencies.shape.install}\` puts it in ${DEPS_DIR}, not in the checkout, since Inspector puts the ` +
    `repository's own files in place at check time. Fabrica's own ${CHECK_SCRIPT} does it with ` +
    `\`[ -d ${DEPS_DIR}/node_modules ] && ln -s ${DEPS_DIR}/node_modules node_modules\`, falling back to ` +
    `\`${dependencies.shape.install}\` anywhere that does have a network; passing --check "<command>" has ` +
    `\`fabrica register\` write that preamble for you.`
  );
}

/**
 * What the Ruby shape knows it has *not* answered (issue #324). Each
 * line is a gap this proposal could leave silently and deliberately does
 * not: the standing rulings call a silent skip a bug, and every one of
 * these is something the Client would otherwise meet as a red first
 * task.
 */
function rubyNotes(signals: ProposalSignals, dependencies: DependencyField): string[] {
  const shape = dependencies.shape;
  if (signals.gemfileLock === null || shape === null) return [];
  const gems = lockedGems(signals);
  const notes: string[] = [];

  // Issue #324, in its own words: "Browser/system tests are out of
  // scope; register says so in its notes when it sees them."
  const browser = BROWSER_GEMS.filter((gem) => gems.has(gem));
  if (browser.length > 0) {
    notes.push(
      `  note: ${GEMFILE_LOCK} names ${browser.join(" and ")}, so this project has browser-driven system ` +
        `tests - and nothing here installs a browser or a driver for one. They are out of scope for what this ` +
        `proposes: a check that has to drive a browser needs it added to ${DOCKERFILE_INSPECTOR}, or those ` +
        `tests left out of the command ${CHECK_SCRIPT} runs.`
    );
  }

  const unserved = UNSERVED_DATABASE_GEMS.filter((gem) => gems.has(gem));
  if (unserved.length > 0) {
    notes.push(
      `  note: ${GEMFILE_LOCK} names ${unserved.join(" and ")}, and this proposal installs no server for ` +
        `${unserved.length === 1 ? `it` : `them`} - only PostgreSQL and Redis are recognized. Add the package ` +
        `to ${DOCKERFILE_INSPECTOR} and start it in ${CHECK_SCRIPT} the way the others are started there, or ` +
        `the suite has nothing to connect to.`
    );
  }

  if (signals.packageLock) {
    notes.push(
      `  note: there is a ${PACKAGE_LOCK} at the root too, and nothing installs it: this is read as a Ruby ` +
        `project with a JavaScript bundler, whose suite is the Ruby one. If the check needs built assets, add ` +
        `an \`npm ci\` step to ${DOCKERFILE_INSPECTOR} and the build command to ${CHECK_SCRIPT}.`
    );
  }

  if ((shape.services ?? []).length > 0) {
    notes.push(
      `  note: starting those servers needs the check box to run as root, which the official Ruby image does. ` +
        `\`fabrica register --check ... --image ...\` runs its own one proving run as *your* user rather than ` +
        `as root, so this is the one check shape that route cannot prove here - commit the files below ` +
        `yourself and register the repository again, or use --terms, and let the first task's own red-or-green ` +
        `be the proof.`
    );
  }

  return notes;
}

export interface ProtectedPathsField {
  /** `undefined` leaves the key out of the document entirely. */
  paths: string[] | undefined;
  reason: string;
}

/**
 * `protectedPaths`. A file-path check is listed; an indirect one lists
 * nothing and says the Client decides (Client ruling, issue #114's
 * clarification) - which file freezing `npm test` means (the script, the
 * `package.json` holding it, the lockfile, all three) is a judgment
 * about his repository, not something to guess.
 *
 * `.inspector.json` itself and the CI workflow files are never listed,
 * by the same ruling: the gate protects those on its own. That is a
 * deliberate difference from `scaffold.ts`'s `protectedPathsFor`, which
 * always lists `.inspector.json` alongside `check.sh` - two different
 * authorities, not a bug in either.
 */
function proposeProtectedPaths(check: CheckField): ProtectedPathsField {
  if (check.file !== null) {
    return {
      paths: [check.file],
      reason:
        `the check is that one file, so a worker free to edit it is a worker free to change what it is judged ` +
        `by - which is the whole subject of CONTRACT rule 9. ${INSPECTOR_CONFIG} and the CI workflow files ` +
        `are deliberately not listed: the gate protects those on its own`,
    };
  }
  return {
    paths: undefined,
    reason:
      `the check is \`${check.command}\`, an indirect command, and which file freezing it means ` +
      `(the script, the ${PACKAGE_JSON} holding it, the lockfile, all three) is yours to decide. ` +
      `${INSPECTOR_CONFIG} and the CI workflow files are deliberately not listed either: the gate protects ` +
      `those on its own`,
  };
}

/**
 * Everything derived from a repository's own signals, with none of it
 * yet committed to being printed or written. Pure: everything it knows
 * came from the strings in `signals`, so a test needs no repository.
 *
 * Both routes share this. `proposeInspectorConfig` below prints it and
 * writes nothing (issue #114); `terms.ts` writes it into the folder
 * `--terms` names and touches the repository not at all. The derivation
 * is identical either way - which is the point: a work-mode project's
 * terms are proposed from the same signals, by the same rules, as the
 * proposal the Client reads on his screen.
 */
export interface ProposalDerivation {
  check: CheckField;
  image: ImageField;
  dependencies: DependencyField;
  protectedPaths: ProtectedPathsField;
  /** `.inspector.json`'s `timeoutSeconds`, or `undefined` to leave the
   * key out entirely and Inspector's own default standing - which is
   * every shape but the one whose check boots its own servers. */
  timeoutSeconds?: number;
  /** `Dockerfile.inspector`'s contents, with a trailing newline. */
  dockerfile: string;
  /**
   * `check.sh`'s contents, for the one case where the derived check
   * cannot be named in `.inspector.json` on its own: the suite needs the
   * script's preamble around it (issue #324's servers and test
   * database), so the config names `./check.sh` and this is the script
   * it names. `null` whenever the config names the command itself, where
   * a printed proposal has no script to propose and the Client's own
   * `check.sh` is his to write.
   *
   * The `--terms` route writes its own `check.sh` for every case, from
   * the same `checkScript` with the same inputs - see terms.ts.
   */
  checkScriptText: string | null;
  /**
   * One line per field, then any disagreement between two signals, then
   * the one warning about the check itself - in order, and the same on
   * both routes. A caller frames them; it never has to assemble them.
   */
  fieldNotes: string[];
  /**
   * The `/deps` linking instruction, for a route that writes no
   * `check.sh` of its own - the Client's own file has to do the linking
   * then. `null` when there is nothing to link, or when `fieldNotes`'
   * warning already said it (one instruction, in one place).
   */
  linkingNote: string | null;
}

/** Reads nothing and writes nothing: the rules, applied to what was
 * read. */
export function deriveProposal(signals: ProposalSignals): ProposalDerivation {
  const pkg = parsedPackageJson(signals.packageJson);
  // The dependency shape first: `check` needs to know whether the
  // command it derives can stand on its own (see proposeCheck).
  const dependencies = proposeDependencies(signals, pkg);
  const check = proposeCheck(signals, pkg, dependencies.shape);
  const image = proposeImage(signals, pkg);
  const protectedPaths = proposeProtectedPaths(check);
  const timeout = proposeTimeout(dependencies);
  const warning = fetchingCheckWarning(check, dependencies);

  return {
    check,
    image,
    dependencies,
    protectedPaths,
    ...(timeout.seconds !== undefined ? { timeoutSeconds: timeout.seconds } : {}),
    dockerfile: inspectorDockerfile({
      from: image.value,
      reason: image.reason,
      shape: dependencies.shape,
    }),
    // The same function the `--terms` route writes its script with, over
    // the same command and the same shape, so the proposal a Client
    // reads and the file that route writes cannot come to differ.
    checkScriptText:
      check.scriptCommand === undefined ? null : checkScript(check.scriptCommand, dependencies.shape),
    fieldNotes: [
      `  check: ${check.command} - ${check.reason}.`,
      `  timeoutSeconds: ${timeout.reason}.`,
      `  protectedPaths: ${protectedPaths.paths === undefined ? "omitted" : protectedPaths.paths.join(", ")} - ` +
        `${protectedPaths.reason}.`,
      // The check box is built from Dockerfile.inspector since
      // inspector#47, so these two are fields of that file rather than
      // keys of a config - there is no `image` key and no `network` key
      // to write any more, with any value.
      `  ${DOCKERFILE_INSPECTOR} FROM: ${image.value} - ${image.reason}.`,
      `  ${DOCKERFILE_INSPECTOR} dependencies: ${dependencies.summary} - ${dependencies.reason}.`,
      ...checkDisagreements(signals, pkg),
      ...rubyNotes(signals, dependencies),
      ...(warning === null ? [] : [warning]),
    ],
    linkingNote: linkingNote(dependencies, warning !== null),
  };
}

/**
 * The whole printed proposal - the route that writes nothing at all.
 */
export function proposeInspectorConfig(
  signals: ProposalSignals,
  ctx: { projectPath: string; defaultBranch: string }
): InspectorProposal {
  const derived = deriveProposal(signals);
  const { check, image, protectedPaths, dockerfile, checkScriptText, linkingNote: linking } = derived;

  const json = inspectorConfigJson({
    check: check.command,
    ...(derived.timeoutSeconds !== undefined ? { timeoutSeconds: derived.timeoutSeconds } : {}),
    ...(protectedPaths.paths !== undefined ? { protectedPaths: protectedPaths.paths } : {}),
  }).trimEnd();

  // Two files for almost every project; three when the derived check
  // needs a script of its own to work at all.
  const count = checkScriptText === null ? `two` : `three`;

  const notes = [
    `fabrica register: ${ctx.projectPath} has no ${INSPECTOR_CONFIG} on origin/${ctx.defaultBranch}, so it ` +
      `needs setting up. Nothing was written and nothing was registered - what follows is a proposal of ` +
      `${count} files, derived from what the repository already says, for you to read and commit yourself.`,
    ...derived.fieldNotes,
    ...(linking === null ? [] : [linking]),
    `${INSPECTOR_CONFIG} is on stdout, alone: \`fabrica register ${ctx.projectPath} > ` +
      `${ctx.projectPath}/${INSPECTOR_CONFIG}\` writes exactly it and nothing else. ${DOCKERFILE_INSPECTOR} ` +
      `goes next to it, and is this - it is deliberately not on stdout, since that stream is the one file ` +
      `the redirect above writes:\n\n${dockerfile.trimEnd()}\n`,
    ...(checkScriptText === null
      ? []
      : [
          `${CHECK_SCRIPT} is the third file, and the one ${INSPECTOR_CONFIG} above names instead of the ` +
            `command itself, because the suite only passes with this preamble around it. It is not on stdout ` +
            `either, for the same reason ${DOCKERFILE_INSPECTOR} is not. Commit it executable ` +
            `(\`chmod +x ${CHECK_SCRIPT}\`):\n\n${checkScriptText.trimEnd()}\n`,
        ]),
    `Read ${checkScriptText === null ? `both` : `all three`}, replace anything marked ` +
      `${IMAGE_PLACEHOLDER_PREFIX}..., commit them onto ${ctx.defaultBranch}, then run ` +
      `\`fabrica register ${ctx.projectPath}\` again. Or pass --check "<command>" --image <docker image> and ` +
      `register will write ${INSPECTOR_CONFIG}, ${CHECK_SCRIPT} and ${DOCKERFILE_INSPECTOR} for you, on a ` +
      `branch, in a pull request you review before it merges. A repository you cannot commit them to at all - ` +
      `a day job's - takes --terms <folder> instead: the same three files, derived the same way, written into ` +
      `that folder, with the repository left alone.`,
  ];

  return { json, dockerfile, checkScript: checkScriptText, notes };
}
