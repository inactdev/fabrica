// Everything `fabrica register` needs to know by asking origin, rather
// than by asking the Client's local checkout.
//
// The distinction matters more here than anywhere else in this module: a
// task's base commit is cut from origin's default branch (src/line/
// cut.ts), never from whatever the Client last had checked out. So
// "is this project set up for Fabrica" is a question about origin's
// default branch, and answering it from local `HEAD` would be answering
// a different question that happens to look the same most of the time.

import { execFileSync } from "node:child_process";
import { fetchOriginDefaultBranch } from "../line/index.ts";
import { declaresTestPaths, INSPECTOR_CONFIG, inspectorIsConfigured } from "../inspector/index.ts";

/** Inspector's own config file - the one file whose presence at a task's
 * base commit decides whether the project is set up at all. Re-exported
 * from src/inspector rather than spelled again here: the name of the file
 * `register` writes and the name of the file the Foreman looks for have
 * to be the same string, by construction. */
export { INSPECTOR_CONFIG };

/** The check script `register` writes, and the only check command it
 * ever records: one file both Inspector and a self-test run, so there is
 * never a second source of truth for "the one command that must pass". */
export const CHECK_SCRIPT = "check.sh";

/** The one branch this command ever creates. Fixed, not per-run: a
 * second `register` on the same repository must collide with the first
 * and refuse, rather than quietly opening a second pull request. */
export const REGISTER_BRANCH = "fabrica/register";

/** The check command recorded in projects.toml and named by
 * .inspector.json - `./check.sh`, whichever path register took. */
export const RECORDED_CHECK = `./${CHECK_SCRIPT}`;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** origin's configured URL, or null when there is no "origin" remote. */
export function originUrl(project: string): string | null {
  try {
    const url = git(project, ["remote", "get-url", "origin"]);
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

/**
 * The repository's own name, from origin's URL - the default for
 * `[projects.<name>]` (Client ruling: "the origin repo name, with an
 * optional --name flag to override").
 *
 * Handles every spelling git accepts for the same remote: scp-style
 * (`git@host:owner/repo.git`), a real URL (`https://host/owner/repo`),
 * and a bare filesystem path (what a test's throwaway bare mirror is),
 * with or without a `.git` suffix or trailing slashes.
 */
export function repoNameFromOriginUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  const last = trimmed.split(/[/:]/).filter((part) => part.length > 0).pop() ?? "";
  return last.replace(/\.git$/, "");
}

/**
 * The owner and repository origin's URL names - what GitHub's own API
 * calls `{owner}/{repo}` - or null when the URL names no such pair (a
 * bare filesystem path with a single segment, something unparseable).
 *
 * The same spellings `repoNameFromOriginUrl` above handles, read one
 * segment deeper: scp-style (`git@host:owner/repo.git`), a real URL
 * (`https://host/owner/repo`, `ssh://git@host/owner/repo.git`), with or
 * without a `.git` suffix or trailing slashes. The last two path
 * segments are the pair, which is exactly how GitHub spells a repository
 * path.
 *
 * Says nothing about the host: a local bare mirror's path can answer
 * this too, and calling its last two directories an owner and a
 * repository would be nonsense to send to api.github.com. Pair it with
 * `hostFromOriginUrl` when that matters - see
 * src/foreman/task-issue.ts.
 */
export function ownerRepoFromOriginUrl(url: string): { owner: string; repo: string } | null {
  const trimmed = url.trim().replace(/\/+$/, "");
  const scp = /^[^/@]+@[^:/]+:(.+)$/.exec(trimmed);
  let path: string | null = scp ? scp[1] : null;
  if (path === null) {
    try {
      path = new URL(trimmed).pathname;
    } catch {
      path = trimmed;
    }
  }
  const parts = path.split("/").filter((part) => part.length > 0);
  if (parts.length < 2) return null;
  const repo = parts[parts.length - 1].replace(/\.git$/, "");
  const owner = parts[parts.length - 2];
  return repo.length > 0 && owner.length > 0 ? { owner, repo } : null;
}

/**
 * origin's host, for scoping `gh auth status` to it. Null for a remote
 * with no host at all (a local path), where there is no host to scope to.
 *
 * Worth scoping: `gh auth status` exits 1 when *any* stored account on
 * *any* host has a problem, so an unrelated stale GitHub Enterprise token
 * would otherwise make a perfectly good login read as "not logged in"
 * (gh's own manual says so, and names --hostname as the fix).
 */
export function hostFromOriginUrl(url: string): string | null {
  const scp = /^[^/@]+@([^:/]+):/.exec(url);
  if (scp) return scp[1];
  try {
    const { hostname } = new URL(url);
    return hostname.length > 0 ? hostname : null;
  } catch {
    return null;
  }
}

/** Whether `path` is in `ref`'s tree, asked of git rather than the
 * filesystem - the Client's working tree is never what's being asked
 * about here. */
export function fileExistsOnRef(project: string, ref: string, path: string): boolean {
  try {
    return git(project, ["ls-tree", "--name-only", ref, "--", path]) === path;
  } catch {
    return false;
  }
}

/** Whether origin has a branch by this name, read straight from the
 * remote (no fetch, no reliance on a local remote-tracking ref that may
 * never have been updated). Throws when origin can't be read at all -
 * "no answer" must never be mistaken for "no branch". */
export function branchExistsOnOrigin(project: string, branch: string): boolean {
  const out = git(project, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
  return out.length > 0;
}

/** Whether a local branch by this name exists. */
export function branchExistsLocally(project: string, branch: string): boolean {
  try {
    git(project, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether origin's default branch - the commit a task would actually be
 * cut from - carries `.inspector.json`.
 *
 * `null` means the question could not be answered: no origin, an
 * unreachable one, a repository with no commits yet. Deliberately not
 * folded into `false`: `fabrica do`'s refusal below turns `false` into
 * "this project isn't set up for Fabrica yet," and saying that to someone
 * whose network is simply down would be both wrong and unhelpful - the
 * real git error downstream says far more. Fetches, for the same reason
 * createProductionLine does: without it, `origin/<default>` is whatever a
 * past fetch happened to leave behind, or nothing at all.
 */
export function inspectorConfiguredOnOrigin(project: string): boolean | null {
  const setup = originSetup(project);
  return setup === null ? null : setup.inspectorConfigured;
}

/** What origin's default branch says about a project, read in one fetch
 * because `fabrica do` wants both answers before it registers anything
 * and fetching twice to get them would be the same question asked twice
 * at network cost. */
export interface OriginSetup {
  /** Whether the commit a task would be cut from carries
   * `.inspector.json` at all - "is this project set up for Fabrica". */
  inspectorConfigured: boolean;
  /** Whether that config declares `testPaths`, which turns on
   * Inspector's model-judged half and so makes a reviewer mandatory
   * (src/reviewer/resolve.ts). */
  declaresTestPaths: boolean;
}

/** `null` means the question could not be answered at all - see
 * `inspectorConfiguredOnOrigin` above for why that is never folded into
 * a "no". */
export function originSetup(project: string): OriginSetup | null {
  let branch: string;
  try {
    branch = fetchOriginDefaultBranch(project);
  } catch {
    return null;
  }
  const revision = `origin/${branch}`;
  try {
    return {
      inspectorConfigured: inspectorIsConfigured(project, revision),
      declaresTestPaths: declaresTestPaths(project, revision),
    };
  } catch {
    return null;
  }
}

/**
 * The exact words `fabrica do` refuses an unregistered project with. Here
 * rather than in src/cli so the command that *fixes* the problem and the
 * command that *reports* it can never drift apart in how they name it.
 */
export function notSetUpMessage(projectPath: string): string {
  return (
    `this project isn't set up for Fabrica yet: run fabrica register ${projectPath} ` +
    `--check ... --image ...`
  );
}
