// The one place a build secret's **value** is ever read (issue #342).
//
// Three callers, and deliberately only three:
//
//   - `src/projectimage/resolve.ts`'s `machineImageBuild`, which hands
//     each one to `docker build` as `--secret id=NAME,env=NAME`, so the
//     value reaches that build's own environment and the `RUN` step
//     that mounts it - never a layer, never `docker history`.
//   - `src/foreman/judge.ts`, which puts them on the environment of the
//     `inspector` child it spawns, for Inspector to pass to its own
//     check-image build the same way (inspector#86).
//   - `fabrica doctor`, which reads only whether each one is **there**
//     and prints the name when it is not.
//
// Everything else gets names. The worker box in particular can never
// get one: its environment is an explicit allowlist built from one
// credential (`src/brain/adapters/index.ts`'s `credentialEnvFrom`), and
// nothing here is in it - see `no-value-outside-the-build.test.ts`,
// which holds that shut structurally rather than by inspection.
//
// The precedence is the one every other credential on this machine has:
// Fabrica's own environment first, then `<recordHome>/brain.env` (mode
// 600, the standing ruling's one home for a secret). A `brain.env` other
// users can read throws from `brainEnvValue`, and that throw is kept as
// the refusal rather than smoothed into "not set" - the same handling
// `src/projecttoken`, `src/reader` and `src/reviewer` give it, and for
// the same reason: a credential file anyone can read is not a
// credential.

import { brainEnvPath, brainEnvValue } from "../brain/index.ts";
import type { FabricaConfig } from "../config/index.ts";
import { workModeFor } from "../workmode/index.ts";
import { declaredBuildSecrets, BUILD_SECRETS_KEY } from "./declared.ts";
import type { BuildSecretsErrorCode } from "./errors.ts";
import { INSPECTOR_CONFIG } from "../inspector/index.ts";

/**
 * Which folder this project's `.inspector.json` is in: the terms folder
 * for a work-mode project (issue #316), whose repository carries none of
 * those files by design, and the repository root for every other one.
 *
 * The same `workModeFor` every other per-project answer is read through,
 * so "where are this project's terms" is one answer with several readers
 * rather than a second opinion formed here.
 */
export function buildSecretsConfigDir(config: FabricaConfig, projectPath: string): string {
  return workModeFor(config, projectPath).terms ?? projectPath;
}

/** What a project's build secrets came to. `names` is on every answer,
 * including the refusal, because a name is always printable and is what
 * every message says. */
export type BuildSecretsResolution =
  /** This project's `.inspector.json` lists none - almost every project.
   * Nothing is mounted, nothing is passed, nothing is looked for. */
  | { kind: "none" }
  /** Every listed name has a value. `values` is the only thing anywhere
   * in Fabrica that holds one, and it goes straight into one child
   * process's environment. */
  | { kind: "ready"; names: string[]; values: Record<string, string> }
  /** At least one listed name has no value here, or cannot be a variable
   * name at all - `reason` says which, so a caller that has to throw
   * does not work it out again from the names. `message` names the
   * variables and never a value. */
  | {
      kind: "refused";
      names: string[];
      missing: string[];
      reason: BuildSecretsErrorCode;
      message: string;
      fix: string;
    };

/** A name Inspector itself accepts: letters, digits and underscores
 * (inspector#86 refuses anything else by name). Checked on the way out
 * of the config rather than only on the way in, because the Client edits
 * that file by hand. */
const LEGAL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ResolveBuildSecretsRequest {
  recordHome: string;
  /** The folder holding this project's `.inspector.json` - see
   * `buildSecretsConfigDir`. */
  configDir: string;
  /**
   * The commit to read that file at, for a config that lives in the
   * repository. A round passes its task's base commit; see
   * `declaredBuildSecrets` for why that is load-bearing rather than
   * tidy. Omitted reads the working tree, which is right for a terms
   * folder (not under git at all) and for `fabrica doctor` (which
   * reports on the checkout in front of the Client, as it does
   * everywhere else).
   */
  revision?: string;
  /** Fabrica's own environment. A value set here wins over `brain.env`,
   * the same precedence every other credential has. */
  env: NodeJS.ProcessEnv;
  /** How the project is named in messages - its registered name when
   * there is one, its path otherwise. */
  projectLabel?: string;
}

/**
 * The variables this project's image build needs, with their values, or
 * exactly which ones cannot be supplied.
 *
 * Asked at every point a build or a handoff is about to happen, and by
 * `fabrica doctor` on each registered project, with the same inputs and
 * the same answer - so what the Client is told up front and what a build
 * refuses on are the same sentence.
 */
export function resolveBuildSecrets(request: ResolveBuildSecretsRequest): BuildSecretsResolution {
  const { recordHome, configDir, env } = request;
  const label = request.projectLabel ?? configDir;
  const names = declaredBuildSecrets(configDir, request.revision);
  if (names.length === 0) return { kind: "none" };

  const illegal = names.filter((name) => !LEGAL_NAME.test(name));
  if (illegal.length > 0) {
    return {
      kind: "refused",
      names,
      missing: illegal,
      reason: "illegal-build-secret-name",
      message:
        `${label} lists ${listed(illegal)} in ${INSPECTOR_CONFIG}'s ${BUILD_SECRETS_KEY}, and ` +
        `${illegal.length === 1 ? `that is not a name` : `those are not names`} an environment variable can ` +
        `have - Inspector refuses a ${BUILD_SECRETS_KEY} entry that is not letters, digits and underscores.`,
      fix: `correct ${listed(illegal)} in ${configDir}/${INSPECTOR_CONFIG}`,
    };
  }

  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of names) {
    // `brainEnvValue` throws for a world-readable brain.env. Deliberately
    // not caught: that is the one problem worth stopping everything for,
    // and it carries its own `chmod 600` message.
    const value = env[name]?.trim() || brainEnvValue(recordHome, name)?.trim();
    if (value === undefined || value.length === 0) missing.push(name);
    else values[name] = value;
  }
  if (missing.length > 0) {
    return {
      kind: "refused",
      names,
      missing,
      reason: "missing-build-secret",
      message: missingBuildSecretMessage(recordHome, label, missing),
      fix:
        `add ${missing.length === 1 ? `a line` : `one line each`} ${missing
          .map((name) => `${name}=<the value>`)
          .join(", ")} to ${brainEnvPath(recordHome)}, then \`chmod 600\` that file`,
    };
  }
  return { kind: "ready", names, values };
}

/** The same question for a caller holding a config and a project path -
 * `fabrica doctor`'s per-project line, which already has both. */
export function resolveProjectBuildSecrets(opts: {
  recordHome: string;
  config: FabricaConfig;
  projectPath: string;
  projectLabel?: string;
  env: NodeJS.ProcessEnv;
}): BuildSecretsResolution {
  return resolveBuildSecrets({
    recordHome: opts.recordHome,
    configDir: buildSecretsConfigDir(opts.config, opts.projectPath),
    env: opts.env,
    ...(opts.projectLabel === undefined ? {} : { projectLabel: opts.projectLabel }),
  });
}

/** The refusal the Client actually meets - the line to paste, and why
 * the build is not attempted without it. Exported so doctor, the image
 * build and the tests all assert on one wording. Names variables; never
 * a value. */
export function missingBuildSecretMessage(recordHome: string, label: string, missing: readonly string[]): string {
  return (
    `${label}'s image build needs ${listed(missing)}, which ${missing.length === 1 ? `is` : `are`} not set. ` +
    `${INSPECTOR_CONFIG} lists ${missing.length === 1 ? `it` : `them`} under ${BUILD_SECRETS_KEY}, because this ` +
    `project installs from a gem source whose credential is not in the repository. Add ` +
    `${missing.length === 1 ? `it` : `each`} as a single line to ${brainEnvPath(recordHome)} (then \`chmod 600\` ` +
    `that file), or set ${missing.length === 1 ? `it` : `them`} in the environment. The build is not attempted ` +
    `without ${missing.length === 1 ? `it` : `them`}: \`bundle install\` would fail inside the image on an ` +
    `authentication error that names nothing about this.`
  );
}

/** How a project's build secrets read in a report - `fabrica doctor`'s
 * per-project line. Names only, always. */
export function describeBuildSecrets(resolution: BuildSecretsResolution): string {
  if (resolution.kind === "none") return "";
  if (resolution.kind === "ready") {
    return `, build ${resolution.names.length === 1 ? `secret` : `secrets`} ${listed(resolution.names)} set`;
  }
  return resolution.message;
}

function listed(names: readonly string[]): string {
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
