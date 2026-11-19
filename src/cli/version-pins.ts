// A project's terms measured against the versions its repository
// declares, and - where Fabrica is allowed to - brought into line
// (issue #355).
//
// The finding: `Dockerfile.inspector` says `FROM ruby:3.4.8` while the
// repository's own `.ruby-version` says 3.4.13, so every task on it
// fails at `bundle install` naming both versions. The fix is the
// argument form (`src/buildargs/`), and who may apply it depends on
// where the file is:
//
//   - **A terms folder outside the repository** is Fabrica's own: it is
//     the folder `fabrica register --terms` wrote, it is not under git,
//     and nothing but Fabrica reads it. `fabrica update` and `fabrica
//     doctor --fix` rewrite it, keep the old file as
//     `Dockerfile.inspector.bak`, print exactly what changed, and leave
//     the project's image stale - which the build step each of those
//     two commands already runs then rebuilds, from the converted file.
//   - **Terms committed inside a repository** are never edited. That is
//     the standing rule for every file of Inspector's in a repository
//     (`src/inspector/config-check.ts`: "Fabrica never edits either
//     file: every refusal here carries the Client's own hand change
//     instead"), and it holds here: `fabrica doctor`'s line shows the
//     exact replacement lines and the Client applies them.
//
// Neither finding stops a task, so neither is a blocking failure: a
// hard-coded version still builds, exactly as it did before this
// existed. It is a FAIL line because it is a real finding with an exact
// fix, and `fabrica up` prints it as a warning above the session rather
// than refusing to start one.

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  configWithBuildArgs,
  INSPECTOR_CONFIG,
  INSPECTOR_DOCKERFILE,
  isLayered,
  loadConfigOrProblem,
  machineImageFor,
  planVersionPinConversion,
  readFileIn,
  replacementLinesFor,
  type MachineImage,
  type VersionPinConversion,
} from "../index.ts";
import type { DoctorCheck } from "./doctor-command.ts";

/** The doctor label one project's version line carries - spelled here,
 * not at each reader, for the same reason `machineImageLabel` is. It
 * sits right after that project's image line, since what it is about is
 * the version that image is built on. */
export function versionPinsLabel(projectName: string): string {
  return `project ${projectName} versions`;
}

/** Where the old file is kept when one is rewritten. Named by issue
 * #355 itself. */
export function backupPathFor(path: string): string {
  return `${path}.bak`;
}

/** Whether this project's terms live in a folder outside its
 * repository, which is the only case anything here may write to. */
export function termsOutsideRepo(machine: MachineImage): boolean {
  return machine.inspectorDockerfile !== null && dirname(machine.inspectorDockerfile) !== machine.project;
}

/** One project's finding: what its terms hard-code, what its repository
 * declares, and whether Fabrica may convert it itself. */
export interface VersionPinFinding {
  machine: MachineImage;
  conversions: VersionPinConversion[];
  /** Families that looked convertible and were not, each with why. */
  skipped: { label: string; reason: string }[];
  /** The converted `Dockerfile.inspector`, for the writer. */
  text: string;
  /** True when the file is Fabrica's to rewrite. */
  writable: boolean;
}

/** What this project's terms need, read off disk. Null for a project on
 * the shared image, which has no `Dockerfile.inspector` of its own and
 * so pins no version anywhere. */
export function versionPinFindingFor(machine: MachineImage): VersionPinFinding | null {
  if (!isLayered(machine)) return null;
  let dockerfile: string;
  try {
    dockerfile = readFileSync(machine.inspectorDockerfile as string, "utf8");
  } catch {
    // Unreadable is the image line's own finding, in its own words
    // (`machineImageCurrency`'s "unreadable" state) - saying it twice,
    // once here in different words, would only bury it.
    return null;
  }
  const plan = planVersionPinConversion(dockerfile, readFileIn(machine.project));
  return {
    machine,
    conversions: plan.conversions,
    skipped: plan.skipped,
    text: plan.text,
    writable: termsOutsideRepo(machine),
  };
}

/**
 * One project's version line.
 *
 * Three things can be on it, in the order they matter: a version this
 * project's terms hard-code that the repository declares in a file (the
 * whole of issue #355), a declared build argument that could not be
 * given a value at all (so the build silently falls back to the
 * Dockerfile's own default, which is the stale version again), and
 * otherwise what each argument resolves to right now.
 */
export function versionPinsCheck(machine: MachineImage, label: string): DoctorCheck {
  const finding = versionPinFindingFor(machine);
  const unresolved = machine.unresolvedBuildArgs;

  if (finding !== null && finding.conversions.length > 0) {
    const names = finding.conversions.map((one) => `${one.label} ${one.pinned}`).join(", ");
    const declares = finding.conversions
      .map((one) => `${one.file} says ${one.declared}`)
      .join(", ");
    return {
      ok: false,
      blocking: false,
      label,
      detail:
        `${machine.inspectorDockerfile} hard-codes ${names}, which this repository declares for itself ` +
        `(${declares}), so a bump there needs an edit here`,
      fix: finding.writable
        ? `fabrica doctor --fix (or fabrica update), which rewrites that file into the build-argument form, ` +
          `keeps the old one as ${INSPECTOR_DOCKERFILE}.bak and rebuilds this project's image`
        : // Committed in the repository, so the change is the Client's
          // to make and the line has to say exactly what it is.
          `these terms are committed in the repository, which Fabrica never edits - ${replacementLinesFor(
            finding.conversions
          )}`,
      needsBuild: false,
    };
  }

  if (unresolved.length > 0) {
    return {
      ok: false,
      blocking: false,
      label,
      detail:
        `${INSPECTOR_CONFIG} declares ${unresolved.map((one) => one.name).join(", ")} but ` +
        unresolved.map((one) => one.reason).join("; ") +
        `, so every build falls back to whatever default ${INSPECTOR_DOCKERFILE} carries`,
      fix:
        `restore the file each one names, or point ${INSPECTOR_CONFIG}'s buildArgs at the file this repository ` +
        `really declares the version in`,
      needsBuild: false,
    };
  }

  const resolved = Object.entries(machine.buildArgs)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${value}`);
  const skipped = (finding?.skipped ?? []).map((one) => `${one.label}: ${one.reason}`);
  if (skipped.length > 0) {
    return {
      ok: false,
      blocking: false,
      label,
      detail: `not converted - ${skipped.join("; ")}`,
      fix: `convert ${machine.inspectorDockerfile} by hand, giving each stage its own build argument`,
      needsBuild: false,
    };
  }

  return {
    ok: true,
    label,
    detail:
      resolved.length > 0
        ? `${resolved.join(", ")}, read from this repository's own files`
        : !isLayered(machine)
          ? `nothing to pin - this project is on the shared image`
          : `no version is read from a file, and none in ${INSPECTOR_DOCKERFILE} is one this repository declares`,
    needsBuild: false,
  };
}

/** What converting one project came to, for the report both commands
 * print. */
export interface VersionPinConversionReport {
  /** The project's name in projects.toml - what the Client calls it. */
  name: string;
  /** "converted", "nothing-to-do", "by-hand" (committed terms, which
   * Fabrica may not edit), or "failed". */
  outcome: "converted" | "nothing-to-do" | "by-hand" | "failed";
  /** Every line of what changed, exactly: the `ARG` added, each `FROM`
   * before and after, the config entry, and where the old file went. */
  changed: string[];
  /** Empty unless `failed`. */
  detail: string;
}

export interface ConvertVersionPinsIo {
  /** Where the report goes, line by line. */
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/**
 * Converts every registered project whose terms Fabrica may rewrite,
 * and says exactly what it did.
 *
 * Called by `fabrica update` and `fabrica doctor --fix` *before* either
 * of them builds a project's machine image - that ordering is the whole
 * mechanism for "and rebuilding that project's worker image": a
 * converted `Dockerfile.inspector` makes the stamp disagree, so the
 * build step each command already runs rebuilds it from the new file,
 * with no second copy of the build logic here.
 *
 * One project's trouble is only that project's: a folder that cannot be
 * written is one report with `outcome: "failed"` and the real error, and
 * the loop carries on.
 */
export function convertProjectVersionPins(
  recordHome: string,
  io: ConvertVersionPinsIo = {}
): VersionPinConversionReport[] {
  const stdout = io.stdout ?? (() => {});
  const stderr = io.stderr ?? (() => {});
  const { config, problem } = loadConfigOrProblem(recordHome);
  if (problem) return [];

  const reports: VersionPinConversionReport[] = [];
  for (const [name, project] of Object.entries(config.projects)) {
    const finding = versionPinFindingFor(machineImageFor(config, project.path));
    if (finding === null || finding.conversions.length === 0) {
      reports.push({ name, outcome: "nothing-to-do", changed: [], detail: "" });
      continue;
    }
    if (!finding.writable) {
      // Committed in the repository. Not an error and not silent: the
      // exact replacement is printed here and stands on this project's
      // own `fabrica doctor` line until the Client applies it.
      const lines = replacementLinesFor(finding.conversions);
      stdout(
        `${name}: ${finding.machine.inspectorDockerfile} is committed in the repository, which Fabrica never ` +
          `edits - ${lines}`
      );
      reports.push({ name, outcome: "by-hand", changed: [lines], detail: "" });
      continue;
    }
    try {
      reports.push({ name, outcome: "converted", changed: writeConversion(finding, stdout), detail: "" });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      stderr(`${name}: ${finding.machine.inspectorDockerfile} could not be converted - ${detail}. Nothing else was affected.`);
      reports.push({ name, outcome: "failed", changed: [], detail });
    }
  }
  return reports;
}

/**
 * Writes one project's conversion: the Dockerfile and, beside it, the
 * `.inspector.json` entry that feeds it. Each file it replaces is
 * copied to `<name>.bak` first, and every line of what changed is
 * printed.
 *
 * The config is written first and the Dockerfile second, deliberately:
 * a config naming a `buildArgs` entry no `ARG` consumes yet is harmless
 * (the value is passed and ignored, and until the Inspector half lands
 * it is ignored anyway), while a Dockerfile reading an argument the
 * config does not supply would fall back to its own default. If the run
 * dies between the two, the worse half is the one that did not happen.
 */
function writeConversion(finding: VersionPinFinding, stdout: (line: string) => void): string[] {
  const dockerfilePath = finding.machine.inspectorDockerfile as string;
  const configPath = join(dirname(dockerfilePath), INSPECTOR_CONFIG);
  const changed: string[] = [];
  const say = (line: string): void => {
    changed.push(line);
    stdout(line);
  };

  const configText = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
  if (configText === null) {
    throw new Error(`there is no ${INSPECTOR_CONFIG} beside it to declare the build arguments in`);
  }
  const updated = configWithBuildArgs(configText, finding.conversions);
  if (updated === null) {
    throw new Error(`${configPath} is not a JSON object, so the build arguments cannot be declared in it`);
  }

  copyFileSync(configPath, backupPathFor(configPath));
  writeFileSync(configPath, updated);
  say(`${configPath}: kept as ${backupPathFor(configPath)}`);
  for (const conversion of finding.conversions) {
    say(`${configPath}: buildArgs += ${JSON.stringify(conversion.entry)}`);
  }

  copyFileSync(dockerfilePath, backupPathFor(dockerfilePath));
  writeFileSync(dockerfilePath, finding.text);
  say(`${dockerfilePath}: kept as ${backupPathFor(dockerfilePath)}`);
  for (const conversion of finding.conversions) {
    say(`${dockerfilePath}: + ${conversion.argLine}`);
    for (const from of conversion.froms) {
      say(`${dockerfilePath}: - ${from.before.trim()}`);
      say(`${dockerfilePath}: + ${from.after.trim()}`);
    }
    say(
      `${conversion.arg} now comes from ${conversion.file}, which says ${conversion.declared} - the next build ` +
        `of this project's image uses it`
    );
  }
  return changed;
}

/** The one line a command's summary carries about this step: how many
 * projects were converted, and - said first, because it is the half
 * that needs acting on - how many could not be. */
export function describeVersionPinConversions(reports: readonly VersionPinConversionReport[]): string {
  const count = (outcome: VersionPinConversionReport["outcome"]): number =>
    reports.filter((one) => one.outcome === outcome).length;
  const failed = count("failed");
  const converted = count("converted");
  const byHand = count("by-hand");
  if (failed > 0) return `${failed} version pin${failed === 1 ? "" : "s"} FAILED to convert, ${converted} converted`;
  if (converted > 0) {
    return `${converted} project${converted === 1 ? "" : "s"} converted to repository version files`;
  }
  if (byHand > 0) return `${byHand} project${byHand === 1 ? "" : "s"} pin${byHand === 1 ? "s" : ""} a version by hand (committed terms)`;
  return "no version pins to convert";
}
