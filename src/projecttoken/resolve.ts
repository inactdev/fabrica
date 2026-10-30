// Which GitHub credential a project's operations go through, and
// whether that is settled enough to make one (issue #314, work mode).
//
// The case this exists for: a company GitHub organization the Client's
// own GitHub App cannot be installed on. There, Fabrica publishes with
// a fine-grained personal token scoped to that one repository, named -
// never held - in projects.toml:
//
//   [projects.dayjob]
//   path           = "~/work/widgets"
//   githubTokenVar = "DAYJOB_GITHUB_TOKEN"
//
// Three things make that deliberately narrow:
//
// 1. **No fallback, in either direction** (the issue's own
//    clarification). A project names a token or it uses the App. A
//    named variable holding nothing is a refusal, never a quiet mint
//    off the App; and a machine with no App configured at all is not an
//    error for a project that names a token.
// 2. **Every GitHub operation, not just the push** (the Client's
//    clarification on this issue). Which operations those are is
//    src/foreman/github-token.ts's business, not this module's - this
//    one only answers which credential, and that single answer is what
//    makes "the App is never reached for this project" true by
//    construction rather than by remembering to check it at each call.
// 3. **The name, never the value, is printable.** `ProjectToken.token`
//    goes into one child process's environment or one request's header.
//    Everything a message, a doctor line or the record says names the
//    variable instead.

import { realpathSync } from "node:fs";
import { brainEnvPath, brainEnvValue } from "../brain/index.ts";
import { projectsTomlPath } from "../config/index.ts";
import type { FabricaConfig } from "../config/index.ts";
import type { ProjectTokenResolution } from "./types.ts";

/**
 * The variable this project names, or undefined when it names none and
 * so uses the GitHub App. Unlike `[reviewer]`/`[reader]`, there is no
 * global table to fall back to: a token is scoped to one repository, so
 * "every project's token" is not a thing that could exist.
 *
 * Matched by resolved path for the same reason `readerFor` and
 * `reviewerFor` are - projects.toml's loader only expands a leading
 * `~`, so without realpath on both sides a symlinked temp dir (macOS's
 * /var -> /private/var) makes one registration look like two.
 */
export function projectTokenVarFor(config: FabricaConfig, projectPath: string): string | undefined {
  const registered = Object.values(config.projects).find((p) => realpath(p.path) === realpath(projectPath));
  return registered?.githubTokenVar;
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Which credential this project's GitHub operations go through, or
 * exactly why none can be settled.
 *
 * Called at every point a task is about to reach GitHub, and by
 * `fabrica doctor` on each registered project, with the same inputs and
 * the same answer - so what the Client is told up front and what a
 * round refuses on are the same sentence.
 */
export function resolveProjectToken(opts: {
  recordHome: string;
  config: FabricaConfig;
  /** The project's path, for finding its own entry. */
  projectPath: string;
  /** How the project is named in messages - its registered name when
   * there is one, otherwise its path. */
  projectLabel?: string;
  /** Fabrica's own environment. A token set here wins over brain.env,
   * the same precedence every other credential on this machine has. */
  env: NodeJS.ProcessEnv;
}): ProjectTokenResolution {
  const { recordHome, config, projectPath, env } = opts;
  const label = opts.projectLabel ?? projectPath;
  const variable = projectTokenVarFor(config, projectPath);
  if (variable === undefined) return { kind: "app" };

  let value: string | undefined;
  try {
    value = env[variable]?.trim() || brainEnvValue(recordHome, variable)?.trim();
  } catch (err) {
    // A brain.env other users can read throws from `brainEnvValue`, and
    // that is the right answer rather than a quiet "not set": a
    // credential file anyone can read is not a credential, and hiding
    // it would hide the one problem worth stopping for. The same
    // handling src/reader and src/reviewer give the same throw.
    return {
      kind: "refused",
      variable,
      message: err instanceof Error ? err.message : String(err),
      fix: `chmod 600 ${brainEnvPath(recordHome)}`,
    };
  }

  if (value === undefined || value.length === 0) {
    return {
      kind: "refused",
      variable,
      message: missingProjectTokenMessage(recordHome, label, variable),
      fix: `add a line ${variable}=<the token> to ${brainEnvPath(recordHome)}, then \`chmod 600\` that file`,
    };
  }
  return { kind: "token", token: { variable, token: value } };
}

/** The refusal for a project whose named variable holds nothing - the
 * one the Client actually meets, so it is the line to paste and the
 * reason this is not quietly the App instead. Exported so doctor, a
 * round's refusal and the tests all assert on one wording. */
export function missingProjectTokenMessage(recordHome: string, label: string, variable: string): string {
  return (
    `${label} is configured to reach GitHub with its own token (githubTokenVar = "${variable}" in ` +
    `${projectsTomlPath(recordHome)}), but ${variable} is not set. Add it as a single line ` +
    `${variable}=<the token> to ${brainEnvPath(recordHome)} (then \`chmod 600\` that file), or set it in the ` +
    `environment. Fabrica does not fall back to the GitHub App for a project that names a token: the App is ` +
    `either this project's credential or it is not, and quietly swapping one for the other would publish ` +
    `under a credential nobody chose.`
  );
}

/** How a project's credential path reads in a report - `fabrica
 * doctor`'s per-project line today. Names the variable, never its
 * value. */
export function describeProjectCredential(resolution: ProjectTokenResolution): string {
  if (resolution.kind === "app") return "reaches GitHub with the GitHub App";
  if (resolution.kind === "token") return `reaches GitHub with its own token (${resolution.token.variable})`;
  return resolution.message;
}
