// Every GitHub credential a task uses, and the record entry that says so
// (issue #187).
//
// The split here is the one `inspection.ts` and `ci-checks.ts` already
// draw: the outside call is a seam a test fakes (`TokenMinter`), and the
// record writing lives HERE, in Fabrica's own code, where no fake can
// skip it. That is what makes "a task's record shows every scoped token
// it minted" a property of the system rather than a property of whatever
// minter happens to be wired in.
//
// Nothing in this file, and nothing downstream of it, ever puts a token
// on the record, in a message, or in Fabrica's own process environment.
// What the record carries is the repository, the installation, the
// permissions GitHub granted, the expiry, and what the token was for.

import { appendEvent } from "../record/index.ts";
import {
  PUBLISH_PERMISSIONS,
  READ_CHECKS_PERMISSIONS,
  READ_ISSUE_PERMISSIONS,
  defaultTokenMinter,
  describePermissions,
} from "../githubapp/index.ts";
import type { GithubScope, MintPurpose, MintedToken, ScopedToken, TokenMinter } from "../githubapp/index.ts";
import { hostFromOriginUrl, originUrl, ownerRepoFromOriginUrl } from "../register/index.ts";
import { ForemanError } from "./errors.ts";

/** The one host Fabrica mints tokens for. A GitHub Enterprise remote has
 * its own API root and its own App; such a project is told so rather
 * than quietly asked about on api.github.com. */
const GITHUB_HOST = "github.com";

/** `"token-minted"`'s own details. Never the token - see this file's
 * header. `permissions` is what GitHub says it granted, read back off
 * its answer rather than echoed from the request, so the record is
 * right even when the App holds less than the call asked for. */
export interface TokenMintedDetails {
  /** What the token was for: `publish`, `read-issue`, `read-checks`. */
  purpose: MintPurpose;
  /** `owner/repo` - the only repository this token can touch. */
  repo: string;
  installationId: number;
  /** e.g. `contents: write, pull_requests: write`, sorted. */
  permissions: string;
  /** GitHub's own expiry, an hour after the mint. */
  expiresAt: string;
  /** GitHub's own `repository_selection` - `selected` for every token
   * Fabrica mints, since every scope names exactly one repository.
   * Recorded rather than assumed: if this ever reads `all`, the one
   * guarantee this whole module exists for has stopped holding. */
  repositorySelection: string;
}

export function tokenMintedDetails(minted: MintedToken, purpose: MintPurpose): TokenMintedDetails {
  return {
    purpose,
    repo: `${minted.owner}/${minted.repo}`,
    installationId: minted.installationId,
    permissions: describePermissions(minted.permissions),
    expiresAt: minted.expiresAt,
    repositorySelection: minted.repositorySelection,
  };
}

/** Wraps any minter so every token it hands out lands on `taskId`'s
 * record. Used for the real minter and for a test's fake alike, which
 * is the point: a suite driving a fake minter still proves the event. */
export function recordingMinter(recordHome: string, taskId: string, minter: TokenMinter): TokenMinter {
  return {
    requireConfigured() {
      minter.requireConfigured();
    },
    async mint(purpose, scope) {
      const minted = await minter.mint(purpose, scope);
      appendEvent(recordHome, { taskId, name: "token-minted", details: tokenMintedDetails(minted, purpose) });
      return minted;
    },
  };
}

/** The production minter for one task: the real GitHub App, with every
 * mint recorded. A caller that already has a minter (a test's fake)
 * passes it instead and still gets the recording. */
export function taskTokenMinter(
  recordHome: string,
  taskId: string,
  minter?: TokenMinter,
  env: NodeJS.ProcessEnv = process.env
): TokenMinter {
  return recordingMinter(recordHome, taskId, minter ?? defaultTokenMinter({ recordHome, env }));
}

/** Which GitHub repository a project's pull requests are opened in, read
 * from its `origin` remote - the same remote every task branch is cut
 * from (src/line/cut.ts). Throws `ForemanError("no-github-repo")`
 * naming the actual state of the project, since without it there is no
 * repository to scope a token to and nothing to publish to either. */
export function projectRepo(project: string): { owner: string; repo: string } {
  const url = originUrl(project);
  if (url === null) {
    throw new ForemanError(
      "no-github-repo",
      `${project} has no "origin" remote, so there is no GitHub repository to mint a token for. Add one ` +
        `with \`git remote add origin <url>\`.`
    );
  }
  if (hostFromOriginUrl(url) !== GITHUB_HOST) {
    throw new ForemanError(
      "no-github-repo",
      `${project}'s "origin" is ${url}, which is not on ${GITHUB_HOST}. Fabrica mints its GitHub tokens from ` +
        `a GitHub App installed on github.com, and has no credential for any other host.`
    );
  }
  const repo = ownerRepoFromOriginUrl(url);
  if (repo === null) {
    throw new ForemanError(
      "no-github-repo",
      `${project}'s "origin" is ${url}, which names no owner/repo. Point it at a repository URL of the form ` +
        `https://github.com/<owner>/<repo>.git.`
    );
  }
  return repo;
}

/** The same question as `projectRepo`, answered with `null` instead of a
 * refusal - for `fabrica doctor`, which reports on every registered
 * project and must not stop at the first one that has no GitHub remote
 * (a project checked by `check.sh` alone is a legitimate registration,
 * it just has no repository for the App to be installed on). */
export function githubRepoOf(project: string): { owner: string; repo: string } | null {
  try {
    return projectRepo(project);
  } catch {
    return null;
  }
}

/** The publishing token for one round's Inspector handoff: this task's
 * repository alone, and only `contents: write` plus `pull_requests:
 * write`.
 *
 * The project's repository is resolved inside `check()`/`mint()` rather
 * than when this is built, so a project with no github.com origin
 * refuses through `Inspector.prepare()`'s own path - one refusal, before
 * any worker starts - instead of throwing while the round is being
 * assembled. */
export function publishToken(recordHome: string, taskId: string, project: string, minter?: TokenMinter): ScopedToken {
  const bound = taskTokenMinter(recordHome, taskId, minter);
  return {
    check() {
      // Both halves, cheapest first: a project with no GitHub remote can
      // never publish, and an unconfigured App can never mint. Neither
      // needs the network.
      projectRepo(project);
      bound.requireConfigured();
    },
    mint() {
      return bound.mint("publish", { ...projectRepo(project), permissions: PUBLISH_PERMISSIONS });
    },
  };
}

/** The scope for reading one issue - which may live in a repository
 * other than the project's own (`owner/repo#N`), and so is named by the
 * caller rather than derived from the project. */
export function readIssueScope(owner: string, repo: string): GithubScope {
  return { owner, repo, permissions: READ_ISSUE_PERMISSIONS };
}

/** The scope for reading a pull request's own checks. */
export function readChecksScope(owner: string, repo: string): GithubScope {
  return { owner, repo, permissions: READ_CHECKS_PERMISSIONS };
}
