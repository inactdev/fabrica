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
//   - whether `package-lock.json` or `go.sum` is there, which decides
//     the install step the Dockerfile gets
//
// Reading is one function; deriving is a pure one over what it read, so
// every rule below is testable with no git and no repository.

import { CHECK_SCRIPT, INSPECTOR_CONFIG, RECORDED_CHECK, fileExistsOnRef, readFileOnRef } from "./origin.ts";
import { inspectorConfigJson } from "./scaffold.ts";
import {
  DOCKERFILE_INSPECTOR,
  GO_MOD,
  GO_SUM,
  PACKAGE_JSON,
  PACKAGE_LOCK,
  dependencyInstallerIn,
  dependencyShapeFrom,
  inspectorDockerfile,
  type DependencyShape,
} from "./dockerfile.ts";

// Re-exported rather than declared again: the filenames a proposal reads
// and the filenames the Dockerfile writer copies have to be the same
// strings, by construction.
export { GO_MOD, PACKAGE_JSON };

/**
 * A marker value, never a guess. Uppercase on purpose: a Docker
 * repository name must be lowercase, so this is an *invalid* reference -
 * a proposal committed without being read fails loudly on the first
 * build instead of silently resolving to something plausible.
 * (`register`'s own proving run pulls the image `--image` names and
 * refuses on a bad one, which is the backstop on that route.)
 */
export const IMAGE_PLACEHOLDER_PREFIX = "REPLACE-ME-with-";

/** The things a repository is read for. `null` means the file isn't on
 * the branch at all; the two lockfiles are read as presence alone, since
 * nothing here cares what is inside one (and one of them is routinely a
 * megabyte). */
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
   * stderr, in order: what happened, one line per field, any
   * disagreement between signals, the Dockerfile itself, and what to do
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

interface CheckField {
  /** What goes in `.inspector.json`'s `check`. */
  command: string;
  /** The repository-relative file that command *is*, when it is one -
   * what `protectedPaths` lists. `null` for an indirect command like
   * `npm test`, where which file to freeze is the Client's call. */
  file: string | null;
  /** The text a check is searched for dependency installers in: the
   * script's own body when there is a script, the command itself
   * otherwise. */
  text: string;
  reason: string;
}

/**
 * `check`. An existing `check.sh` wins over every other signal (Client
 * ruling), and any signal it disagrees with is named rather than
 * silently dropped.
 */
function proposeCheck(signals: ProposalSignals, pkg: Record<string, unknown> | null): CheckField {
  if (signals.checkScript !== null) {
    const body = checkScriptBody(signals.checkScript);
    return {
      command: RECORDED_CHECK,
      file: CHECK_SCRIPT,
      text: signals.checkScript,
      reason:
        `the repository already has a ${CHECK_SCRIPT} at its root, and an existing one wins over every ` +
        `other signal` +
        (body.length > 0 ? `. It runs: ${body}` : ``),
    };
  }

  const testScript = stringField(pkg, "scripts", "test");
  if (testScript !== null) {
    return {
      command: "npm test",
      file: null,
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
      reason:
        `${GO_MOD} makes this a Go module${version === null ? `` : ` (go ${version})`} and nothing in it names ` +
        `another command, so the toolchain's own test command stands`,
    };
  }

  return {
    command: RECORDED_CHECK,
    file: CHECK_SCRIPT,
    text: "",
    reason:
      `nothing in the repository names a command that has to pass - no ${CHECK_SCRIPT}, no ${PACKAGE_JSON} ` +
      `"test" script, no ${GO_MOD}. Write ${CHECK_SCRIPT} with the one command you want held to, and this ` +
      `names it`,
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
  return notes;
}

interface ImageField {
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

interface DependencyField {
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
  const shape = dependencyShapeFrom({ packageLock: signals.packageLock, goSum: signals.goSum });
  if (shape !== null) {
    return {
      shape,
      summary: `${shape.install} from ${shape.lockfile}`,
      reason: shape.note,
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
      `nothing in the repository declares a dependency to install - no ${PACKAGE_LOCK}, no ${GO_SUM}, and ` +
      `nothing in ${PACKAGE_JSON} or ${GO_MOD} naming one. The file says so where an install step would have ` +
      `gone, since the check box has no network to get one later`,
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
            ? ` - link them in the way this repository's own ${CHECK_SCRIPT} does (\`[ -d /deps/node_modules ] ` +
              `&& ln -s /deps/node_modules node_modules\`) rather than fetching`
            : ``
        }.`)
  );
}

interface ProtectedPathsField {
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
 * The whole proposal. Pure: everything it knows came from the three
 * strings in `signals`, so a test needs no repository.
 */
export function proposeInspectorConfig(
  signals: ProposalSignals,
  ctx: { projectPath: string; defaultBranch: string }
): InspectorProposal {
  const pkg = parsedPackageJson(signals.packageJson);
  const check = proposeCheck(signals, pkg);
  const image = proposeImage(signals, pkg);
  const dependencies = proposeDependencies(signals, pkg);
  const protectedPaths = proposeProtectedPaths(check);

  const json = inspectorConfigJson({
    check: check.command,
    ...(protectedPaths.paths !== undefined ? { protectedPaths: protectedPaths.paths } : {}),
  }).trimEnd();

  const dockerfile = inspectorDockerfile({
    from: image.value,
    reason: image.reason,
    shape: dependencies.shape,
  });

  const warning = fetchingCheckWarning(check, dependencies);

  const notes = [
    `fabrica register: ${ctx.projectPath} has no ${INSPECTOR_CONFIG} on origin/${ctx.defaultBranch}, so it ` +
      `needs setting up. Nothing was written and nothing was registered - what follows is a proposal of two ` +
      `files, derived from what the repository already says, for you to read and commit yourself.`,
    `  check: ${check.command} - ${check.reason}.`,
    // Always omitted, and the one field where that is the whole answer:
    // nothing in a package.json, a go.mod or a check.sh says how long a
    // check takes, and an invented number is the number that would
    // decide whether a real check is killed mid-run.
    `  timeoutSeconds: omitted - nothing in the repository says how long the check takes, so Inspector's own ` +
      `default stands. Set it once you have watched the check run.`,
    `  protectedPaths: ${protectedPaths.paths === undefined ? "omitted" : protectedPaths.paths.join(", ")} - ` +
      `${protectedPaths.reason}.`,
    // The check box is built from Dockerfile.inspector since
    // inspector#47, so these two are fields of that file rather than
    // keys of a config - there is no `image` key and no `network` key to
    // write any more, with any value.
    `  ${DOCKERFILE_INSPECTOR} FROM: ${image.value} - ${image.reason}.`,
    `  ${DOCKERFILE_INSPECTOR} dependencies: ${dependencies.summary} - ${dependencies.reason}.`,
    ...checkDisagreements(signals, pkg),
    ...(warning === null ? [] : [warning]),
    `${INSPECTOR_CONFIG} is on stdout, alone: \`fabrica register ${ctx.projectPath} > ` +
      `${ctx.projectPath}/${INSPECTOR_CONFIG}\` writes exactly it and nothing else. ${DOCKERFILE_INSPECTOR} ` +
      `goes next to it, and is this - it is deliberately not on stdout, since that stream is the one file ` +
      `the redirect above writes:\n\n${dockerfile.trimEnd()}\n`,
    `Read both, replace anything marked ${IMAGE_PLACEHOLDER_PREFIX}..., commit them onto ` +
      `${ctx.defaultBranch}, then run \`fabrica register ${ctx.projectPath}\` again. Or pass ` +
      `--check "<command>" --image <docker image> and register will write ${INSPECTOR_CONFIG}, ` +
      `${CHECK_SCRIPT} and ${DOCKERFILE_INSPECTOR} for you, on a branch, in a pull request you review before ` +
      `it merges.`,
  ];

  return { json, dockerfile, notes };
}
