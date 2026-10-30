// The production `TokenMinter`: reads the App's credentials off this
// machine, signs a JWT, and mints one short-lived, one-repository token
// per call.
//
// What it deliberately does not do:
//
//   - cache a token. Every call gets its own, scoped to that call's
//     permissions and discarded by the caller afterwards. Issue #187's
//     whole point is that a credential is narrow and brief; a cache
//     would make it neither.
//   - fall back to anything. With no App configured, or a mint GitHub
//     refuses, the call refuses and names the setup step (Client
//     ruling, clarification 2: "Fail loudly ... no fallback"). There is
//     no personal token left in the configuration to try instead.
//
// The one thing it remembers is which installation covers a given
// repository, which is a public fact about the App and not a
// credential. That halves the API calls a task makes - without it every
// mint is two round trips to GitHub - and an installation id does not
// change while a task runs.

import { requireAppCredentials } from "./config.ts";
import { mintInstallationToken } from "./mint.ts";
import type { AppFetch, GithubScope, MintPurpose, MintedToken, TokenMinter } from "./types.ts";

export interface TokenMinterOptions {
  recordHome: string;
  /** Fabrica's own environment by default; never modified. */
  env?: NodeJS.ProcessEnv;
  fetchImpl?: AppFetch;
  /** Overridden only by tests pointing at a stub server. */
  apiRoot?: string;
  now?: () => number;
  /** Told about every token minted - the repository, the installation,
   * the permissions GitHub granted and the expiry, never the token
   * itself. This is the hook `src/foreman/github-token.ts` uses to put
   * `"token-minted"` on the task's record; nothing in this module
   * reaches the record on its own. */
  onMinted?: (minted: MintedToken, purpose: MintPurpose) => void;
}

export function defaultTokenMinter(opts: TokenMinterOptions): TokenMinter {
  const env = opts.env ?? process.env;
  const installations = new Map<string, number>();

  const credentials = () => requireAppCredentials(env, opts.recordHome);

  return {
    requireConfigured() {
      credentials();
    },

    async mint(purpose, scope) {
      const key = `${scope.owner}/${scope.repo}`;
      const call = {
        credentials: credentials(),
        ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
        ...(opts.apiRoot === undefined ? {} : { apiRoot: opts.apiRoot }),
        ...(opts.now === undefined ? {} : { now: opts.now }),
      };
      const known = installations.get(key);
      const minted = await mintInstallationToken({
        ...call,
        scope,
        ...(known === undefined ? {} : { installationId: known }),
      });
      installations.set(key, minted.installationId);
      opts.onMinted?.(minted, purpose);
      return minted;
    },
  };
}

/** A credential bound to one purpose and one scope, for a caller that
 * has no business knowing either - `src/inspector/run.ts` is handed one
 * of these so the adapter never learns which repository it publishes to,
 * which permissions that needs, or even whether an App was involved: a
 * project may publish with a token of its own instead (issue #314).
 *
 * `mint()` answers the token and nothing else, deliberately - an
 * installation id, a granted-permission map and an expiry are facts
 * about an App token that a project's own token does not have, and this
 * seam's one consumer never read them. Whoever needs them holds a
 * `TokenMinter` instead. */
export interface ScopedToken {
  /** The sync, no-network half: refuses now if the credential could not
   * possibly work (`Inspector.prepare()`). */
  check(): void;
  mint(): Promise<{ token: string }>;
}

export function scopedToken(minter: TokenMinter, purpose: MintPurpose, scope: GithubScope): ScopedToken {
  return {
    check() {
      minter.requireConfigured();
    },
    mint() {
      return minter.mint(purpose, scope);
    },
  };
}
