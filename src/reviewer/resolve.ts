// Who reviews a project's test changes, and whether that is settled
// enough to hand Inspector anything at all.
//
// Inspector's run judges a change's *test* edits with a model of its
// own, named by `-vendor`/`-model` and paid for with that vendor's own
// key. Fabrica configures it, because Fabrica is the side that knows
// which vendor the Worker already is - and the standing ruling is that
// the reviewer must never be the Worker's own vendor. A reviewer drawn
// from the same vendor as the Worker is not a second opinion; it is the
// same house marking its own homework one step removed, which is the
// thing an independent inspection exists to prevent. That ruling is
// enforced here, in code, not left to whoever writes projects.toml.
//
// Everything below compares vendor names as opaque strings. The one
// place allowed to know what any of them actually are is
// src/brain/adapters/ (CONTRACT rule 8), which is where `workerVendor`
// comes from.
//
// Its own module rather than a file under src/inspector/ for one
// reason: settling a reviewer needs the Worker's vendor and the record
// home's credential file, so it depends on src/brain - and src/inspector
// has no business depending on brains at all. src/inspector takes only
// the `ResolvedReviewer` type from here, erased at compile time.

import { realpathSync } from "node:fs";
import { brainEnvPath, brainEnvValue, workerVendor } from "../brain/index.ts";
import { projectsTomlPath } from "../config/index.ts";
import type { FabricaConfig, ReviewerConfig } from "../config/index.ts";
import type { ResolvedReviewer, ReviewerResolution } from "./types.ts";

/** `<VENDOR>_API_KEY` / `<VENDOR>_BASE_URL` for a vendor name - the
 * spelling Inspector itself reads, derived rather than tabulated so a
 * vendor Fabrica has never heard of works the same as any other. */
export function apiKeyVarFor(vendor: string): string {
  return `${envPrefixFor(vendor)}_API_KEY`;
}

export function baseUrlVarFor(vendor: string): string {
  return `${envPrefixFor(vendor)}_BASE_URL`;
}

function envPrefixFor(vendor: string): string {
  return vendor.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

/**
 * The reviewer table that governs `projectPath`: the project's own
 * `[projects.<name>.reviewer]` when it has one, otherwise the global
 * `[reviewer]`. The project wins outright.
 *
 * Matched by resolved path, the same way `resolveCheckCommand` finds a
 * project's own check command - projects.toml's loader only expands a
 * leading `~`, so both sides go through realpath or a symlinked temp
 * dir (macOS's `/var` -> `/private/var`) would make one registration
 * look like two different projects.
 */
export function reviewerFor(config: FabricaConfig, projectPath: string): ReviewerConfig | undefined {
  const registered = Object.values(config.projects).find((p) => realpath(p.path) === realpath(projectPath));
  return registered?.reviewer ?? config.reviewer;
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Settles the reviewer for one project, or says exactly why it cannot
 * be settled. Called twice with the same inputs and the same answer:
 * once by `fabrica do` before anything is registered or spent, and
 * again by the round itself before Inspector is called, so a resumed
 * round, a fix round, and a library caller all refuse on the same three
 * grounds the Client sees up front.
 *
 * `declaresTestPaths` is the project's own `.inspector.json` saying it
 * wants its test changes judged. It is what makes a reviewer required;
 * a project that declares none and configures none is simply `none`.
 */
export function resolveReviewer(opts: {
  recordHome: string;
  config: FabricaConfig;
  /** The project's path, for finding its own reviewer table. */
  projectPath: string;
  /** How the project is named in messages - its registered name when
   * there is one, otherwise its path. */
  projectLabel?: string;
  declaresTestPaths: boolean;
  /** Fabrica's own environment. A credential set here wins over
   * brain.env, the same precedence the Worker's own token has. */
  env: NodeJS.ProcessEnv;
}): ReviewerResolution {
  const { recordHome, config, projectPath, declaresTestPaths, env } = opts;
  const label = opts.projectLabel ?? projectPath;
  const configured = reviewerFor(config, projectPath);

  if (configured === undefined) {
    if (!declaresTestPaths) return { kind: "none" };
    return {
      kind: "refused",
      message:
        `${label} declares testPaths in its .inspector.json, so its test changes are judged by a model, ` +
        `but no reviewer is configured. Add a [reviewer] table to ${projectsTomlPath(recordHome)}:\n\n` +
        `  [reviewer]\n` +
        `  vendor = "<the reviewing vendor>"\n` +
        `  model  = "<that vendor's model>"\n\n` +
        `Or give this project its own, which overrides the global one:\n\n` +
        `  [projects.<name>.reviewer]\n` +
        `  vendor = "<the reviewing vendor>"\n` +
        `  model  = "<that vendor's model>"\n\n` +
        `The reviewer must not be the worker's own vendor - a model does not independently review itself.`,
    };
  }

  const worker = workerVendor(env, recordHome);
  if (sameVendor(configured.vendor, worker)) {
    return {
      kind: "refused",
      message:
        `the reviewer configured for ${label} is "${configured.vendor}", which is also the worker's vendor ` +
        `("${worker}"). A reviewer must never be the worker's vendor - that is the same house marking its own ` +
        `homework, not an independent review. Name a different vendor in the [reviewer] table in ` +
        `${projectsTomlPath(recordHome)}.`,
    };
  }

  const apiKeyVar = apiKeyVarFor(configured.vendor);
  const baseUrlVar = baseUrlVarFor(configured.vendor);
  let apiKey: string | undefined;
  let baseUrl: string | undefined;
  try {
    apiKey = credential(env, recordHome, apiKeyVar);
    baseUrl = credential(env, recordHome, baseUrlVar);
  } catch (err) {
    // A brain.env other users can read is a refusal in its own words,
    // never quietly read as "no key configured" - hiding that would be
    // hiding the one problem worth stopping for. Returned rather than
    // thrown so every caller of this function gets a message to show,
    // not an exception to decide what to do with.
    return { kind: "refused", message: err instanceof Error ? err.message : String(err) };
  }
  if (apiKey === undefined) {
    return {
      kind: "refused",
      message:
        `the reviewer configured for ${label} is "${configured.vendor}", but ${apiKeyVar} is not set. ` +
        `Add it as a single line ${apiKeyVar}=<key> to ${brainEnvPath(recordHome)} (then ` +
        `\`chmod 600\` that file), or set it in the environment. Without it Inspector would be handed a ` +
        `reviewer it cannot use.`,
    };
  }

  return {
    kind: "reviewer",
    reviewer: {
      vendor: configured.vendor,
      model: configured.model,
      apiKeyVar,
      apiKey,
      baseUrlVar,
      ...(baseUrl === undefined ? {} : { baseUrl }),
    },
  };
}

/** Vendor names are the Client's own spelling on both sides, so they are
 * compared the way a person would read them: trimmed, case-insensitive. */
function sameVendor(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** One value from Fabrica's environment, else from `brain.env` - the
 * same 600-mode file the Worker's own credential already lives in, so a
 * machine keeps all of this in one place. An unreadable or
 * world-readable file throws from `brainEnvValue`, which is the right
 * answer: a credential file anyone can read is not a credential. */
function credential(env: NodeJS.ProcessEnv, recordHome: string, name: string): string | undefined {
  const fromEnv = env[name];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv;
  return brainEnvValue(recordHome, name);
}
