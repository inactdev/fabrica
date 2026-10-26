// Who reads a change's whole diff after Inspector has called it green,
// and whether that is settled enough to read anything at all.
//
// Inspector issue #34 and its amendment: every task gets a code reader
// after Inspector's green. It never blocks and never approves - it
// flags, and its findings go back to the same machine as a fix round
// before the delivery. This module is the whole of "which model, and is
// that settled".
//
// Three things make it deliberately unlike its sibling, src/reviewer:
//
// 1. **Absence is a refusal, always.** A reviewer is only required by a
//    project whose `.inspector.json` declares `testPaths`; a reader is
//    wired into every task Inspector runs on, so there is no shape of
//    project it is optional for. A project with no `[reader]` is
//    refused at task start, with the exact lines to add.
// 2. **It never falls back to `[reviewer]`.** The Client's own ruling:
//    the two tables are separate so the two jobs can be given to
//    different models, and quietly borrowing one for the other would
//    make that choice unmakeable while looking like it had been made.
// 3. **`<VENDOR>_BASE_URL` is required, not forwarded-when-set.** A
//    reviewer's endpoint is Inspector's problem; this call is Fabrica's
//    own, so Fabrica needs somewhere to send it - and it holds no
//    vendor-to-endpoint table. Nothing in this module names a vendor,
//    a model or a harness: CONTRACT rule 8's scan reads every file
//    under src/ outside adapters/, this file and this module's README
//    included.
//
// The credential's variable naming (`<VENDOR>_API_KEY` /
// `<VENDOR>_BASE_URL`) is imported from src/reviewer rather than
// re-derived here, deliberately: one vendor must resolve to one key
// variable whichever job it is doing, and two copies of that rule are
// how a key set under one spelling goes unread under the other. Only
// the naming is shared - the tables, the resolutions and the refusals
// are this module's own.

import { realpathSync } from "node:fs";
import { brainEnvPath, brainEnvValue } from "../brain/index.ts";
import { projectsTomlPath } from "../config/index.ts";
import type { FabricaConfig, ReaderConfig } from "../config/index.ts";
import { apiKeyVarFor, baseUrlVarFor } from "../reviewer/index.ts";
import type { ReaderResolution } from "./types.ts";

/**
 * The reader table that governs `projectPath`: the project's own
 * `[projects.<name>.reader]` when it has one, otherwise the global
 * `[reader]`. The project wins outright, not field by field.
 *
 * Matched by resolved path for the same reason `reviewerFor` is -
 * projects.toml's loader only expands a leading `~`, so without
 * realpath on both sides a symlinked temp dir (macOS's /var ->
 * /private/var) makes one registration look like two.
 */
export function readerFor(config: FabricaConfig, projectPath: string): ReaderConfig | undefined {
  const registered = Object.values(config.projects).find((p) => realpath(p.path) === realpath(projectPath));
  return registered?.reader ?? config.reader;
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Settles the reader for one project, or says exactly why it cannot be
 * settled. Called twice with the same inputs and the same answer: once
 * by `fabrica do` before anything is registered or spent, and again by
 * the round itself before any worker starts, so a resumed round, a fix
 * round and a library caller all refuse on the same grounds the Client
 * sees up front.
 */
export function resolveReader(opts: {
  recordHome: string;
  config: FabricaConfig;
  /** The project's path, for finding its own reader table. */
  projectPath: string;
  /** How the project is named in messages - its registered name when
   * there is one, otherwise its path. */
  projectLabel?: string;
  /** Fabrica's own environment. A credential set here wins over
   * brain.env, the same precedence the worker's own token has. */
  env: NodeJS.ProcessEnv;
}): ReaderResolution {
  const { recordHome, config, projectPath, env } = opts;
  const label = opts.projectLabel ?? projectPath;
  const configured = readerFor(config, projectPath);

  if (configured === undefined) {
    return { kind: "refused", message: missingReaderMessage(recordHome, label) };
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
    // never quietly read as "no key configured" - the same handling
    // src/reviewer gives it, and for the same reason: hiding that would
    // be hiding the one problem worth stopping for.
    return { kind: "refused", message: err instanceof Error ? err.message : String(err) };
  }

  if (apiKey === undefined) {
    return {
      kind: "refused",
      message:
        `the code reader configured for ${label} is "${configured.vendor}", but ${apiKeyVar} is not set. ` +
        `Add it as a single line ${apiKeyVar}=<key> to ${brainEnvPath(recordHome)} (then \`chmod 600\` ` +
        `that file), or set it in the environment.`,
    };
  }
  if (baseUrl === undefined) {
    return {
      kind: "refused",
      message:
        `the code reader configured for ${label} is "${configured.vendor}", but ${baseUrlVar} is not set. ` +
        `Fabrica calls the reader itself, so it needs that vendor's own chat-completions endpoint - it ` +
        `keeps no table of them. Add a single line ${baseUrlVar}=<the endpoint root, without ` +
        `/chat/completions> to ${brainEnvPath(recordHome)}, or set it in the environment.`,
    };
  }

  return {
    kind: "reader",
    reader: {
      vendor: configured.vendor,
      model: configured.model,
      apiKeyVar,
      apiKey,
      baseUrlVar,
      baseUrl,
    },
  };
}

/** The refusal for a project with no reader at all - the one the Client
 * is most likely to meet, so it is the lines to paste and nothing else.
 * Exported so `fabrica doctor`-style callers and tests assert on one
 * wording rather than their own copy of it. */
export function missingReaderMessage(recordHome: string, label: string): string {
  return (
    `no code reader is configured for ${label}. Every task's diff is read after Inspector turns it green, ` +
    `so there is nothing to run until one is named. Add a [reader] table to ` +
    `${projectsTomlPath(recordHome)}:\n\n` +
    `  [reader]\n` +
    `  vendor = "<the reading vendor>"\n` +
    `  model  = "<that vendor's model>"\n\n` +
    `Or give this project its own, which overrides the global one:\n\n` +
    `  [projects.<name>.reader]\n` +
    `  vendor = "<the reading vendor>"\n` +
    `  model  = "<that vendor's model>"\n\n` +
    `[reader] is separate from [reviewer] on purpose and is never taken from it: the reviewer judges a ` +
    `change's test edits inside Inspector's own run, the reader reads the whole diff afterwards and only ` +
    `flags. Name each one yourself.`
  );
}

/** One value from Fabrica's environment, else from `brain.env` - the
 * same 600-mode file the worker's own credential already lives in. An
 * unreadable or world-readable file throws from `brainEnvValue`, which
 * is the right answer: a credential file anyone can read is not a
 * credential. */
function credential(env: NodeJS.ProcessEnv, recordHome: string, name: string): string | undefined {
  const fromEnv = env[name];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv;
  return brainEnvValue(recordHome, name);
}
