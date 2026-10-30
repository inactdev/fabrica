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
// Both credentials above are about a vendor reached over the network.
// Issue #315 added a second way to reach a model - a command on this
// machine, for a work account whose only access is a coding-agent CLI on
// a subscription - and such a vendor wants neither variable: the one
// thing that can be missing is the command itself. Which vendors those
// are is asked of src/brain/adapters (`cliReaderFor`), the only place
// allowed to know, so this module still names nothing.
//
// The credential's variable naming (`<VENDOR>_API_KEY` /
// `<VENDOR>_BASE_URL`) is imported from src/reviewer rather than
// re-derived here, deliberately: one vendor must resolve to one key
// variable whichever job it is doing, and two copies of that rule are
// how a key set under one spelling goes unread under the other. Only
// the naming is shared - the tables, the resolutions and the refusals
// are this module's own.

import { realpathSync } from "node:fs";
import { brainEnvPath, brainEnvValue, cliReaderFor } from "../brain/index.ts";
// Type only, erased at compile time: what the lookup above answered, so
// the refusal can name the real problem. The barrel's own path names
// nobody, which is what makes importing it here allowed at all (see this
// file's header).
import type { CommandLookup } from "../brain/index.ts";
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

  // Issue #315's work mode, asked of the one directory allowed to know
  // the answer: is this vendor reached by running something on this
  // machine rather than by calling an endpoint with a key? If it is,
  // there is no credential to look for at all - the installed, already
  // signed-in command *is* the credential - and the one thing that can
  // be wrong is that the command is not there. That is a refusal at task
  // start naming it, which is this issue's own clarification and the
  // same place the other three refusals land.
  // Only a vendor the adapter directory actually serves takes this
  // branch - matched on the whole name, so a vendor merely *spelled like*
  // one of those is nobody's here and falls through to the ordinary key
  // and endpoint below, exactly as every other vendor does.
  const viaCommand = cliReaderFor(configured.vendor);
  if (viaCommand !== undefined) {
    const found = viaCommand.locate(env);
    if (!found.found) {
      return {
        kind: "refused",
        message: missingCommandMessage(label, configured.vendor, viaCommand.command, found),
      };
    }
    return {
      kind: "reader",
      reader: { via: "command", vendor: configured.vendor, model: configured.model, command: viaCommand.command },
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
      via: "api",
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

/** The refusal for a vendor whose calls go through a command on this
 * machine when that command cannot be run (issue #315). It names the
 * command, because that is the whole of what is missing, and says out
 * loud that no key is wanted here - otherwise the obvious reading of any
 * reader refusal is "set a credential", which for this vendor would send
 * the Client looking for one that does not exist.
 *
 * It also names the *real* problem rather than the likely one: a command
 * sitting right there without the executable bit is a `chmod`, not an
 * install, and a refusal that said "not on PATH" about it would send him
 * to fix something that is already fine. Exported so a test asserts on
 * one wording rather than its own copy of it. */
export function missingCommandMessage(
  label: string,
  vendor: string,
  command: string,
  found: Extract<CommandLookup, { found: false }>
): string {
  const problem =
    found.why === "not-executable"
      ? `\`${command}\` is at ${found.path} but cannot be run - make it executable (\`chmod +x ${found.path}\`) ` +
        `and run the task again`
      : `\`${command}\` is not on PATH. Install it (or put it on PATH) and run the task again`;
  return (
    `the code reader configured for ${label} is "${vendor}", whose calls go through the \`${command}\` command ` +
    `on this machine, but ${problem}. ` +
    `This reader needs no API key and no endpoint - the signed-in \`${command}\` on this machine is how it reaches ` +
    `a model; only its model name comes from the [reader] table.`
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
