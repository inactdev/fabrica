// The one place outside the adapters themselves allowed to name them
// (this directory is exempt from rule8.no-favorite-brain's scan). Picks
// which written adapter backs `defaultBrainAdapter()`: the CLI adapter
// built for the Client's own flat-rate subscription by default, or - when
// the Client deliberately opens the per-token pipe (`FABRICA_BRAIN`, see
// `selectedBrain` below) - the direct-API adapter issue #200 added, which
// refuses to run without a spending cap.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { claudeCodeAdapter, claudeCodeCheckBox, type ClaudeCodeAdapterOptions } from "./claude-code.ts";
import { HOSTED_CREDENTIAL_VAR, openAiCompatibleAdapter } from "./openai-compatible.ts";
import type { CostSource } from "./openai-agent/types.ts";
import type { Brain } from "../types.ts";
import type { CheckBox } from "../check-box.ts";

/** The one host environment variable a contained worker may inherit
 * (issue #85) - the headless credential `claude setup-token` mints.
 * Everything else in the host's environment stays out of the container,
 * which is the whole point of `ClaudeCodeAdapterOptions.env` being an
 * explicit allowlist rather than a pass-through. */
const CREDENTIAL_VAR = "CLAUDE_CODE_OAUTH_TOKEN";

/** Where the worker token lives when it is not in Fabrica's environment:
 * a file Fabrica reads itself, so no shell profile has to export it. */
export function brainEnvPath(recordHome: string): string {
  return join(recordHome, "brain.env");
}

/** Builds the adapter's options: exactly `CREDENTIAL_VAR`, from the host
 * environment when it is set there, otherwise from
 * `<recordHome>/brain.env`. That file must hold only a
 * `CLAUDE_CODE_OAUTH_TOKEN=...` line (blank lines and `#` comments
 * aside) and be readable by its owner alone. Throws, with a message for
 * the Client and never the token, when neither source has it. The token
 * only ever goes into the container's env-file - never into Fabrica's
 * own process environment.
 *
 * Exported so it can be tested: the chosen `env` is invisible on the
 * `Brain` a factory returns (name/model/work/ask). */
export function credentialEnvFrom(env: NodeJS.ProcessEnv, recordHome: string): ClaudeCodeAdapterOptions {
  const fromEnv = env[CREDENTIAL_VAR];
  if (fromEnv) return { env: { [CREDENTIAL_VAR]: fromEnv } };

  const path = brainEnvPath(recordHome);
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    throw new Error(
      `No worker token: ${CREDENTIAL_VAR} is not set, and ${path} does not exist. Run \`claude setup-token\`, ` +
        `then put the token in ${path} as a single line ${CREDENTIAL_VAR}=<token> and run \`chmod 600 ${path}\`.`
    );
  }
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `${path} can be read by other users on this machine (mode ${(mode & 0o777).toString(8)}), and it holds the ` +
        `worker token. Run \`chmod 600 ${path}\`, then try again.`
    );
  }
  // Only the token line is read - an optional `export ` lets the same file
  // be sourced by a shell - and every other line is ignored, never forwarded.
  const tokenLine = new RegExp(`^(?:export\\s+)?${CREDENTIAL_VAR}=(.*)$`);
  const tokens = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => tokenLine.exec(line.trim())?.[1])
    .filter((token): token is string => token !== undefined);
  if (tokens.length !== 1 || tokens[0].length === 0) {
    throw new Error(
      `${path} must hold exactly one line ${CREDENTIAL_VAR}=<token> (optionally after \`export \`). Run ` +
        `\`claude setup-token\` for a token if you need one.`
    );
  }
  return { env: { [CREDENTIAL_VAR]: tokens[0] } };
}

/** Which brain the Client has chosen, and how it is configured. Every
 * name below belongs to this directory, the only one rule 8 lets a brain
 * be named in; the values are the Client's. `FABRICA_BRAIN` is the one
 * switch: left unset, nothing changes and the flat-rate CLI worker runs,
 * exactly as before. Each is read from Fabrica's own environment first,
 * then from `<recordHome>/brain.env`, so a machine can keep all of it in
 * the one 600-mode file it already keeps the credential in. */
export const BRAIN_SELECTION_VAR = "FABRICA_BRAIN";
export const DIRECT_BRAIN_NAME = "openai-compatible";
export const DIRECT_VARS = {
  /** The model id, e.g. an open-weight model's slug. No default: this
   * adapter has no favourite model, and a slug guessed here would fail
   * at the first call with the provider's own error instead of ours. */
  model: "FABRICA_MODEL",
  /** Optional - defaults to the adapter's own vendor. Point it at any
   * OpenAI-compatible base URL, a local server included. */
  baseUrl: "FABRICA_MODEL_BASE_URL",
  /** Optional - `reported` or `free`; see `CostSource`. */
  cost: "FABRICA_MODEL_COST",
} as const;

/** One variable out of `<recordHome>/brain.env`, or undefined when the
 * file has no such line. Separate from `credentialEnvFrom` below on
 * purpose: that function's job is to refuse a missing worker token with
 * an instructive message, while a missing line here is an ordinary
 * "not configured". The mode check is the same, because the file is the
 * same file and it holds a credential. */
export function brainEnvValue(recordHome: string, name: string): string | undefined {
  const path = brainEnvPath(recordHome);
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    return undefined;
  }
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `${path} can be read by other users on this machine (mode ${(mode & 0o777).toString(8)}), and it holds a ` +
        `credential. Run \`chmod 600 ${path}\`, then try again.`
    );
  }
  const line = new RegExp(`^(?:export\\s+)?${name}=(.*)$`);
  const values = readFileSync(path, "utf8")
    .split("\n")
    .map((raw) => line.exec(raw.trim())?.[1])
    .filter((value): value is string => value !== undefined && value.length > 0);
  return values.length === 1 ? values[0] : undefined;
}

function setting(env: NodeJS.ProcessEnv, recordHome: string, name: string): string | undefined {
  const fromEnv = env[name];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return brainEnvValue(recordHome, name);
}

/** How the direct-API worker is configured, when it is the one selected
 * - raw, unvalidated, so `fabrica doctor` can report what is missing
 * rather than only refusing. Undefined means the Client has not opened
 * that pipe at all, which is the default. */
export interface DirectBrainSettings {
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  cost?: string;
}

export function directBrainSettings(env: NodeJS.ProcessEnv, recordHome: string): DirectBrainSettings | undefined {
  if (setting(env, recordHome, BRAIN_SELECTION_VAR) !== DIRECT_BRAIN_NAME) return undefined;
  return {
    model: setting(env, recordHome, DIRECT_VARS.model),
    baseUrl: setting(env, recordHome, DIRECT_VARS.baseUrl),
    apiKey: setting(env, recordHome, HOSTED_CREDENTIAL_VAR),
    cost: setting(env, recordHome, DIRECT_VARS.cost),
  };
}

/** The brain `defaultBrainAdapter` builds, chosen from the settings
 * above. Exported for its own test: the choice is invisible on the
 * `Brain` it returns beyond `name`/`model`. */
export function selectedBrain(env: NodeJS.ProcessEnv, recordHome: string): Brain {
  const direct = directBrainSettings(env, recordHome);
  if (direct === undefined) {
    return claudeCodeAdapter(credentialEnvFrom(env, recordHome));
  }

  const { model, apiKey, baseUrl, cost } = direct;
  if (model === undefined) {
    throw new Error(
      `${BRAIN_SELECTION_VAR}=${DIRECT_BRAIN_NAME} is set, but no model is: this worker has no favourite model, so ` +
        `name one with ${DIRECT_VARS.model} (in the environment, or as a line in ${brainEnvPath(recordHome)}).`
    );
  }
  if (cost !== undefined && cost !== "reported" && cost !== "free") {
    throw new Error(`${DIRECT_VARS.cost} must be "reported" or "free" (it is "${cost}") - see the adapter's own doc for what each means.`);
  }
  return openAiCompatibleAdapter({
    model,
    // The file src/config/load.ts's projectsTomlPath names, spelled out
    // here rather than imported: a brain adapter has no business
    // depending on the config loader, and this is only ever a path
    // printed in a refusal message.
    capSetting: join(recordHome, "projects.toml"),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(cost === undefined ? {} : { costSource: cost as CostSource }),
  });
}

/** The vendor behind the CLI worker that runs by default, and the one
 * behind the direct-API worker `FABRICA_BRAIN` opens. Named here
 * because this directory is the only one anywhere under `src/` allowed
 * to name a vendor at all (CONTRACT rule 8) - everything downstream
 * compares these as opaque strings. */
export const CLI_WORKER_VENDOR = "anthropic";
export const DIRECT_WORKER_VENDOR = "openrouter";

/**
 * Which vendor the selected Worker belongs to - the one fact the
 * standing ruling on reviewers tests against ("the reviewer must never
 * be the worker's vendor", src/reviewer/resolve.ts).
 *
 * `Brain.name` is deliberately not this: it names the *adapter*, not
 * the company whose model is answering, and two adapters could front
 * the same vendor. Read from the same settings `selectedBrain` reads,
 * so "who is the worker" and "whose vendor is that" can never disagree.
 *
 * Known limit: this is the selected adapter's own nominal vendor. The
 * direct-API adapter pointed at some other OpenAI-compatible base URL
 * still reports `DIRECT_WORKER_VENDOR`, since nothing in a base URL
 * reliably names the company behind it.
 */
export function workerVendor(env: NodeJS.ProcessEnv, recordHome: string): string {
  try {
    return directBrainSettings(env, recordHome) === undefined ? CLI_WORKER_VENDOR : DIRECT_WORKER_VENDOR;
  } catch {
    // An unreadable or badly-permissioned brain.env is reported properly
    // by the first real call; the default worker is the honest answer
    // until something actually selects another one.
    return CLI_WORKER_VENDOR;
  }
}

/** What to call the selected brain before it has been built - a plain
 * look at the settings that never validates and never throws, so
 * building a `defaultBrainAdapter` stays free (see below). */
function brainLabels(env: NodeJS.ProcessEnv, recordHome: string): { name: string; model: string } {
  try {
    if (setting(env, recordHome, BRAIN_SELECTION_VAR) === DIRECT_BRAIN_NAME) {
      return { name: DIRECT_BRAIN_NAME, model: setting(env, recordHome, DIRECT_VARS.model) ?? "unset" };
    }
  } catch {
    // An unreadable or badly-permissioned brain.env is reported properly
    // by the first real call, which is where a refusal belongs.
  }
  return { name: "claude-code", model: "default" };
}

/** The real worker. Which adapter it is, and its token, are both looked
 * up at its first call, not here, so building one costs nothing and never
 * fails - an `accept` verdict, for one, never needs a worker at all. A
 * missing token or an unnamed model then refuses that first call (the
 * clarifying step, before any worker starts), and the Foreman records
 * why. */
export function defaultBrainAdapter(recordHome: string): Brain {
  let inner: Brain | undefined;
  const real = (): Brain => (inner ??= selectedBrain(process.env, recordHome));
  const labels = brainLabels(process.env, recordHome);
  return {
    get name() {
      return inner?.name ?? labels.name;
    },
    get model() {
      return inner?.model ?? labels.model;
    },
    ask: async (brief) => real().ask(brief),
    work: async (brief, workdir, opts) => real().work(brief, workdir, opts),
  };
}

/** The default worker's box, for self-testing a project with no Inspector. */
export function defaultCheckBox(): CheckBox {
  return claudeCodeCheckBox();
}
