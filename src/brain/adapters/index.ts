// The one place outside claude-code.ts itself allowed to name it (this
// directory is exempt from rule8.no-favorite-brain's scan). Picks which
// written adapter backs `defaultBrainAdapter()` - v1 has exactly one
// (adapters/README.md's "v1 ordering"), so there is no real selection
// logic yet, only a seam for src/brain/index.ts to re-export without
// naming a vendor itself.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { claudeCodeAdapter, claudeCodeCheckBox, type ClaudeCodeAdapterOptions } from "./claude-code.ts";
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
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const prefix = `${CREDENTIAL_VAR}=`;
  if (lines.length !== 1 || !lines[0].startsWith(prefix) || lines[0].length === prefix.length) {
    throw new Error(
      `${path} must hold exactly one line, ${CREDENTIAL_VAR}=<token>, and nothing else. Run \`claude setup-token\` ` +
        `for a token if you need one.`
    );
  }
  return { env: { [CREDENTIAL_VAR]: lines[0].slice(prefix.length) } };
}

/** The real worker. Its token is looked up at its first call, not here,
 * so building one costs nothing and never fails - an `accept` verdict, for
 * one, never needs a worker at all. A missing token then refuses that
 * first call (the clarifying step, before any worker starts), and the
 * Foreman records why. */
export function defaultBrainAdapter(recordHome: string): Brain {
  let inner: Brain | undefined;
  const real = (): Brain => (inner ??= claudeCodeAdapter(credentialEnvFrom(process.env, recordHome)));
  return {
    name: "claude-code",
    model: "default",
    ask: async (brief) => real().ask(brief),
    work: async (brief, workdir, opts) => real().work(brief, workdir, opts),
  };
}

/** The default worker's box, for self-testing a project with no Inspector. */
export function defaultCheckBox(): CheckBox {
  return claudeCodeCheckBox();
}
