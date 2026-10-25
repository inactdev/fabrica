// The shapes this module's own callers hold. Nothing here is a type
// `contract/surface.ts` declares: an App's credentials and the token it
// mints are how Fabrica reaches GitHub, not a seam Fabrica promises the
// Client, so they are internal to this module (AGENTS.md's test: if
// changing the type changes what Fabrica *promises*, it is a contract
// type; if it only changes how code is organised, it stays in src).

/** The two levels a repository permission can be asked for. GitHub's own
 * App-permissions object accepts `admin` for a handful of keys; nothing
 * Fabrica does needs one, so it is deliberately not spellable here. */
export type AppPermission = "read" | "write";

/** Exactly which repository a token may touch, and exactly what it may
 * do there. One repository, always - a scope naming two would be the
 * thing issue #187 exists to prevent. */
export interface GithubScope {
  owner: string;
  repo: string;
  /** GitHub's own permission keys (`contents`, `pull_requests`,
   * `issues`, `checks`, `statuses`, `actions`, ...) - see
   * `scopes.ts` for the sets Fabrica actually asks for. */
  permissions: Readonly<Record<string, AppPermission>>;
}

/** One minted installation token, as GitHub handed it over. */
export interface MintedToken {
  /** The credential itself. Never logged, never recorded, never put in
   * Fabrica's own process environment. */
  token: string;
  /** GitHub's own ISO-8601 expiry - an hour after the mint. */
  expiresAt: string;
  owner: string;
  repo: string;
  /** What GitHub says it granted, which can be narrower than what was
   * asked for but never wider. Read back off the response rather than
   * echoed from the request, so the record says what is true. */
  permissions: Record<string, string>;
  installationId: number;
  /** `all` or `selected` - `selected` for every token Fabrica mints,
   * since every scope names one repository. Read back off the response
   * for the same reason `permissions` is. */
  repositorySelection: string;
}

/** Why a token was minted, in the words the record carries. One short
 * phrase per call site, so a task's own history reads as a list of what
 * Fabrica did rather than a list of permission objects. */
export type MintPurpose =
  /** Inspector's handoff: push the task branch, open or update its pull
   * request. */
  | "publish"
  /** The issue a task names, read once at registration. */
  | "read-issue"
  /** The checks the repository runs on the pull request itself. */
  | "read-checks";

/** Where a short-lived, one-repo token comes from. The one seam every
 * GitHub call in Fabrica goes through, so a test never needs a real App
 * and the real path never has a personal-token fallback to fall back to
 * (`helpers/fake-minter.ts` is the test side). */
export interface TokenMinter {
  /**
   * Everything that can be checked without the network: both settings
   * present, the key file readable at mode 600, and parsable as a
   * private key. Throws `GithubAppError` with the setup step when it
   * cannot be, so a caller that must refuse before it starts anything
   * (`Inspector.prepare()`) can do so synchronously.
   */
  requireConfigured(): void;
  /** One token for one call, discarded by the caller when that call is
   * done. Throws `GithubAppError` naming the cause - there is no
   * fallback credential to try instead (Client ruling). */
  mint(purpose: MintPurpose, scope: GithubScope): Promise<MintedToken>;
}

/** Just enough of `fetch` for the three calls this module makes - the
 * global one satisfies it, and a stub needs only a status and a body. */
export type AppFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string }
) => Promise<{ status: number; text(): Promise<string> }>;

/** What `GET /app` says about the App whose key this machine holds -
 * `fabrica doctor`'s proof that the key signs a JWT GitHub accepts. */
export interface AppIdentity {
  /** The App's URL slug, e.g. `fabrica-factory`. */
  slug: string;
  /** Its display name. */
  name: string;
  /** How many accounts the App is installed on. Zero means registered
   * but never installed, which is a real failure with its own fix. */
  installations: number;
}
