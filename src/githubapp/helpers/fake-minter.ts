// The test-only `TokenMinter`. Every suite that touches a code path
// which mints uses this, so no test needs a registered GitHub App, a
// private key, or the network - the same role
// `contract/helpers/fake-inspector.ts` plays for Inspector.
//
// It records what it was asked for, which is what most tests actually
// want to assert: that a call minted exactly one repository's worth of
// exactly the permissions that call needs.

import type { GithubScope, MintPurpose, MintedToken, TokenMinter } from "../types.ts";

export interface FakeMintCall {
  purpose: MintPurpose;
  scope: GithubScope;
}

export interface FakeMinter extends TokenMinter {
  readonly calls: FakeMintCall[];
}

export interface FakeMinterOptions {
  /** The token every mint hands back. A test that asserts a credential
   * reached the right place sets this and looks for it. */
  token?: string;
  /** Thrown by `requireConfigured()` and `mint()` alike - the shape of
   * a machine with no App configured. */
  refuse?: Error;
  /** Thrown by `mint()` only: configured, but GitHub refused. */
  refuseMint?: Error;
}

export function fakeMinter(opts: FakeMinterOptions = {}): FakeMinter {
  const calls: FakeMintCall[] = [];
  const token = opts.token ?? "fake-installation-token";
  return {
    calls,
    requireConfigured() {
      if (opts.refuse) throw opts.refuse;
    },
    async mint(purpose, scope): Promise<MintedToken> {
      if (opts.refuse) throw opts.refuse;
      calls.push({ purpose, scope });
      if (opts.refuseMint) throw opts.refuseMint;
      return {
        token,
        // A fixed, obviously-fake hour from an epoch date: nothing in
        // Fabrica reads this value for anything but the record, and a
        // real clock here would make an event's details untestable.
        expiresAt: "2026-01-01T01:00:00Z",
        owner: scope.owner,
        repo: scope.repo,
        permissions: { ...scope.permissions },
        installationId: 42,
        repositorySelection: "selected",
      };
    },
  };
}
