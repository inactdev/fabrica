// A task that cannot be published must never be worked (issue #304).
//
// On 2026-10-27 four tasks ran, reached Inspector, went green, and ended
// as incomplete publications: the GitHub App's installation token lacked
// `statuses: write`, so posting the `inspector` commit status answered
// 403. Nothing on Fabrica's side could have said so earlier - the only
// checks that existed proved the App's key signs and the installation
// covers the repository, neither of which says what a token minted off
// that installation would be allowed to do.
//
// This gate mints that token at task start and reads what GitHub granted
// on it (`src/githubapp/publish-permissions.ts`). No write is attempted;
// the grant is the evidence. The mint is the task's own, so it lands on
// the task's record as `"token-minted"` like every other, and the token
// is discarded.
//
// It refuses on exactly one finding: a mint that succeeded and came back
// short. Everything else - no App configured, a project with no
// github.com origin, a key GitHub rejects, GitHub unreachable - leaves
// the task to proceed exactly as it does today. That is deliberate, and
// it is the difference between evidence and the absence of it: a project
// with no `.inspector.json` at its base commit publishes nothing at all
// (judge.ts's `chooseCheckMode` self-test mode) and legitimately has
// neither an App nor a github.com remote, so refusing those here would
// stop work that has always worked and that issue #304 says nothing
// about. Each of them already refuses loudly at the point publishing is
// actually about to happen - `publishToken`'s `check()`, from
// `Inspector.prepare()`, before any push - and `fabrica doctor`'s own
// github-app line reports the could-not-ask cases to the one person who
// can act on them.

import { githubRepoOf, taskTokenMinter } from "./github-token.ts";
import { loadConfigOrProblem } from "../config/index.ts";
import { publishPermissionGap } from "../githubapp/index.ts";
import type { TokenMinter } from "../githubapp/index.ts";
import { resolveProjectToken } from "../projecttoken/index.ts";
import { ForemanError } from "./errors.ts";

/**
 * Throws `ForemanError("publish-not-permitted")` when GitHub would mint
 * this project a publishing token short of what publishing needs. The
 * caller records it: every start path that calls this runs inside
 * `recordingFailure`, which appends `"task-failed"` with this message
 * before it reaches the Client's terminal.
 */
export async function requirePublishPermissions(
  recordHome: string,
  taskId: string,
  project: string,
  /** Issue #187's seam - a test's fake minter. Omitted uses the real App
   * on this machine. */
  minter?: TokenMinter,
  /** Fabrica's own environment, for reading this project's own token if
   * it names one. */
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  // No github.com repository behind this project means no App token is
  // involved in anything it does, so there is no grant to read.
  const repo = githubRepoOf(project);
  if (repo === null) return;

  // Issue #314: a project that publishes with its own token mints no App
  // token at all, so there is no grant to read for it either - and a
  // fine-grained personal token's own scopes are not readable the way an
  // installation token's granted permissions are (GitHub exposes them
  // nowhere this check could ask). The gate this file exists to be is
  // therefore not available for such a project, and is skipped rather
  // than guessed at. What still catches a token that cannot publish: the
  // push itself, reported as Inspector's own failure, and `fabrica
  // doctor`, which checks the token is configured at all. A token
  // missing entirely is refused before any worker starts, by
  // `publishToken`'s `check()` through `Inspector.prepare()`.
  const resolution = resolveProjectToken({
    recordHome,
    config: loadConfigOrProblem(recordHome).config,
    projectPath: project,
    env,
  });
  if (resolution.kind !== "app") return;

  let gap;
  try {
    gap = await publishPermissionGap(taskTokenMinter(recordHome, taskId, minter), repo.owner, repo.repo);
  } catch {
    // The check could not be taken. See this file's header for why that
    // is not a refusal, and where it is reported instead.
    return;
  }
  if (gap === null) return;

  throw new ForemanError(
    "publish-not-permitted",
    `Refused before anything started: ${gap.detail}. Nothing was started - to fix it, ${gap.fix}, then ` +
      `confirm with \`fabrica doctor\` and run the task again.`
  );
}
