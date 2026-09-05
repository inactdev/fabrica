// The one place outside claude-code.ts itself allowed to name it (this
// directory is exempt from rule8.no-favorite-brain's scan). Picks which
// written adapter backs `defaultBrainAdapter()` - v1 has exactly one
// (adapters/README.md's "v1 ordering"), so there is no real selection
// logic yet, only a seam for src/brain/index.ts to re-export without
// naming a vendor itself.

import { claudeCodeAdapter, type ClaudeCodeAdapterOptions } from "./claude-code.ts";
import type { Brain } from "../types.ts";

/** The one host environment variable a contained worker may inherit
 * (issue #85) - the headless credential `claude setup-token` mints.
 * Everything else in the host's environment stays out of the container,
 * which is the whole point of `ClaudeCodeAdapterOptions.env` being an
 * explicit allowlist rather than a pass-through. */
const CREDENTIAL_VAR = "CLAUDE_CODE_OAUTH_TOKEN";

/** Builds the adapter's options from a host environment: exactly
 * `CREDENTIAL_VAR` when it is set, and nothing at all when it is not.
 *
 * Exported only so it can be tested. The chosen `env` is invisible on
 * the `Brain` a factory returns (the interface is name/model/work/ask),
 * so asserting the choice from outside is impossible - this is the
 * single place it can be observed. */
export function credentialEnvFrom(env: NodeJS.ProcessEnv): ClaudeCodeAdapterOptions {
  const token = env[CREDENTIAL_VAR];
  return token ? { env: { [CREDENTIAL_VAR]: token } } : {};
}

export function defaultBrainAdapter(): Brain {
  return claudeCodeAdapter(credentialEnvFrom(process.env));
}
