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
//
// There are two credentials a task can have, decided per project and
// never one as the other's fallback (issue #314, work mode). The App is
// the default. A project whose projects.toml entry names the
// brain.env variable holding its own GitHub token - for an organization
// the App cannot be installed on - uses that token for EVERY GitHub
// operation, and `taskGithubCredential` below is the one function that
// knows which: every GitHub call in Fabrica gets its token from there,
// so a call added later cannot accidentally get the App for a project
// that has its own token. Which credential a project uses is
// src/projecttoken/'s answer; what a call does with it is here.

import { appendEvent } from "../record/index.ts";
import { loadConfigOrProblem } from "../config/index.ts";
import {
  READ_CHECKS_PERMISSIONS,
  READ_ISSUE_PERMISSIONS,
  defaultTokenMinter,
  describePermissions,
  publishPermissionsFor,
} from "../githubapp/index.ts";
import { projectWorkMode } from "../workmode/index.ts";
import type { GithubScope, MintPurpose, MintedToken, ScopedToken, TokenMinter } from "../githubapp/index.ts";
import { resolveProjectToken } from "../projecttoken/index.ts";
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

/** `"project-token-used"`'s own details (issue #314). Never the token -
 * `variable` is its *name*, which is the half that is safe to print and
 * the half anyone reading the record actually needs. */
export interface ProjectTokenUsedDetails {
  /** What the call was for: `publish`, `read-issue`, `read-checks` -
   * the same vocabulary the App's own event uses, since it describes
   * the call rather than the credential. */
  purpose: MintPurpose;
  /** `owner/repo` - the repository this call was against. */
  repo: string;
  /** The name of the `brain.env` variable the token was read from. */
  variable: string;
}

/**
 * One GitHub credential for one call, however this project gets one
 * (issue #314). Every GitHub operation a task makes goes through this,
 * which is what makes "a project that names its own token never reaches
 * the App, and a project that names none never reaches anything else"
 * true by construction rather than by each call site remembering to
 * ask.
 */
export interface TaskGithubCredential {
  /**
   * Everything answerable without the network: the App configured and
   * its key usable, or this project's own token present. Throws with
   * the Client's own next step, so a caller that must refuse before it
   * starts anything (`Inspector.prepare()`) can do so synchronously.
   */
  check(): void;
  /** The token for one call, recorded on the task and discarded by the
   * caller afterwards. */
  token(purpose: MintPurpose, scope: GithubScope): Promise<string>;
}

/**
 * Which credential this task's GitHub calls go through: this project's
 * own token when its projects.toml entry names one, otherwise a token
 * minted from the GitHub App. Never both, and never one as the other's
 * fallback (issue #314's clarification).
 *
 * The decision is taken per call rather than cached, so a `githubTokenVar`
 * added to projects.toml between two rounds of the same task is read the
 * same way every other per-project setting is.
 *
 * A projects.toml that will not parse answers "the App", the same
 * tolerance `registeredProject` has and for the same reason: a round
 * refuses on a broken registry long before this, in resolve-check.ts,
 * and a credential lookup must not become the second, worse reporter of
 * it.
 */
export function taskGithubCredential(
  recordHome: string,
  taskId: string,
  project: string,
  /** The App's seam - a test's fake minter. Only reached for a project
   * that names no token of its own. */
  minter?: TokenMinter,
  env: NodeJS.ProcessEnv = process.env
): TaskGithubCredential {
  const resolve = () =>
    resolveProjectToken({
      recordHome,
      config: loadConfigOrProblem(recordHome).config,
      projectPath: project,
      env,
    });
  // Built at most once, and only for a project that uses the App: the
  // real minter remembers which installation covers a repository, which
  // is what keeps a second call from being a second round trip.
  let app: TokenMinter | undefined;
  const appMinter = () => (app ??= taskTokenMinter(recordHome, taskId, minter, env));

  return {
    check() {
      const resolution = resolve();
      if (resolution.kind === "refused") throw new ForemanError("project-token-unavailable", resolution.message);
      // A project with its own token never asks whether the App is
      // configured: on the machine this setting exists for, it cannot
      // be, and that is not an error (issue #314's clarification).
      if (resolution.kind === "app") appMinter().requireConfigured();
    },
    async token(purpose, scope) {
      const resolution = resolve();
      if (resolution.kind === "refused") throw new ForemanError("project-token-unavailable", resolution.message);
      if (resolution.kind === "app") return (await appMinter().mint(purpose, scope)).token;
      const details: ProjectTokenUsedDetails = {
        purpose,
        repo: `${scope.owner}/${scope.repo}`,
        variable: resolution.token.variable,
      };
      appendEvent(recordHome, { taskId, name: "project-token-used", details });
      return resolution.token.token;
    },
  };
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
 * repository alone, and - when it comes from the App - only `contents:
 * write`, `pull_requests: write` and `statuses: write`. A project that
 * names its own token in projects.toml publishes with that instead, and
 * no App token is minted for it at all (issue #314).
 *
 * `statuses: write` is dropped for a project Inspector posts no commit
 * status for (issue #316's `noStamp`): a handoff that will not stamp
 * must not hold the permission to, and an App that was never granted it
 * would answer the mint itself with a refusal. Read from the registry
 * here rather than passed in, so this and issue #304's start gate - the
 * one that checks what GitHub granted on exactly this mint - can never
 * be asking about two different sets.
 *
 * The project's repository is resolved inside `check()`/`mint()` rather
 * than when this is built, so a project with no github.com origin
 * refuses through `Inspector.prepare()`'s own path - one refusal, before
 * any worker starts - instead of throwing while the round is being
 * assembled. */
export function publishToken(recordHome: string, taskId: string, project: string, minter?: TokenMinter): ScopedToken {
  const credential = taskGithubCredential(recordHome, taskId, project, minter);
  return {
    check() {
      // Both halves, cheapest first: a project with no GitHub remote can
      // never publish, and a credential this machine does not have can
      // never be used. Neither needs the network.
      projectRepo(project);
      credential.check();
    },
    async mint() {
      const permissions = publishPermissionsFor(projectWorkMode(recordHome, project).noStamp);
      const scope = { ...projectRepo(project), permissions };
      return { token: await credential.token("publish", scope) };
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
