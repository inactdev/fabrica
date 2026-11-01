// The one place anything in Fabrica asks the GitHub CLI for a token
// (issue #331).
//
// The case this exists for: an organization the Client's GitHub App
// cannot be installed on, where he already works through `gh`, logged in
// as himself. Issue #314's answer - a token in `brain.env` - would put a
// second copy of that same secret on disk, and it would go stale every
// time `gh` refreshes its login. So a project may say instead:
//
//   [projects.dayjob]
//   path        = "~/work/widgets"
//   githubToken = "gh"
//
// and every GitHub operation Fabrica makes for it asks `gh` at the
// moment of that one call.
//
// Two sharp edges this file exists to hold in one place:
//
// 1. **`gh auth token` prints the credential on stdout.** Nothing here
//    returns, logs, records or reports that stdout except as the token
//    itself: every message built from a failed run reads `stderr` only.
//    A diagnostic that echoed the command's whole output would print the
//    Client's own GitHub credential into his terminal, and `fabrica
//    status`/`fabrica log` would carry it from then on.
// 2. **"Not installed" and "not logged in" are different fixes**, so
//    they are different findings, named separately. gh's own documented
//    exit codes (`gh help exit-codes`) are 0 success, 1 failure, 2
//    cancelled, 4 authentication required - and a spawn that fails
//    outright with ENOENT is the binary not being there at all.
//
// `--no-refresh` is deliberately NOT passed: gh refreshes a token that
// is expired or close to it before printing, and that refresh is the
// whole reason this setting is better than a copied token. One call per
// GitHub operation is therefore also what keeps the login fresh.

import { spawnSync } from "node:child_process";
import { projectsTomlPath } from "../config/index.ts";

/** The GitHub CLI, as it is spelled on PATH. Overridable per call for
 * tests only - no caller in production names anything else. */
export const GH_COMMAND = "gh";

/** The one host Fabrica asks `gh` for a token for. Named explicitly
 * rather than left to gh's own default host, which a `GH_HOST` in the
 * environment or an enterprise login can move: the token is about to be
 * used against api.github.com, so it must be the github.com login. */
export const GH_HOSTNAME = "github.com";

/** The command whose output is the token. Exported so the fix lines and
 * the tests name the same call this module actually makes. */
export const GH_TOKEN_ARGS = ["auth", "token", "--hostname", GH_HOSTNAME] as const;

/** How the Client logs in, which is the fix for almost everything that
 * can be wrong here. */
export const GH_LOGIN_COMMAND = `${GH_COMMAND} auth login --hostname ${GH_HOSTNAME}`;

/** Something definite that is wrong with this machine's `gh` login, in
 * the two halves every refusal and every `fabrica doctor` line is built
 * from: one sentence naming what is wrong, and the command that fixes
 * it. Never the token, and never `gh`'s stdout. */
export interface GhProblem {
  /** One complete sentence, no leading capital and no trailing period -
   * it is pasted into a doctor line and into a refusal alike. */
  detail: string;
  /** The exact command to run, as the Client would type it. */
  fix: string;
}

/** The answer to "can this machine produce a GitHub token from `gh`" -
 * the credential, or a definite finding about why not. There is
 * deliberately no third "could not tell" answer: the question is about
 * one local command, and a command that cannot be run has told us the
 * answer. (The *push* question is the one with an unknown - see
 * `gh-push.ts`.) */
export type GhTokenResult = { kind: "token"; token: string } | ({ kind: "problem" } & GhProblem);

/** How long `gh auth token` is given to answer. It reads this machine's
 * own keychain, and may make one refresh call; a minute is far more than
 * either needs, and the point of the limit is only that a round never
 * hangs forever on a command waiting for something. */
const GH_TIMEOUT_MS = 60_000;

/**
 * This machine's GitHub token, from `gh auth token --hostname
 * github.com`, read at the moment of the call that needs it and never
 * stored anywhere by this module.
 *
 * The caller discards it when its one GitHub call returns. Nothing here
 * caches it: a cache would outlive the call it was read for, and a
 * refreshed login would leave the stale copy behind.
 */
export function ghAuthToken(
  opts: {
    /** Tests only: a stand-in `gh` on disk. Production always spawns
     * `gh` from PATH, exactly as the Client's own shell does. */
    command?: string;
    env?: NodeJS.ProcessEnv;
  } = {}
): GhTokenResult {
  const command = opts.command ?? GH_COMMAND;
  const run = spawnSync(command, [...GH_TOKEN_ARGS], {
    env: opts.env ?? process.env,
    encoding: "utf8",
    timeout: GH_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (run.error !== undefined) {
    const code = (run.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        kind: "problem",
        detail: `the GitHub CLI (\`${command}\`) is not installed on this machine, so no token can be read for it`,
        fix: `install the GitHub CLI (brew install gh), then \`${GH_LOGIN_COMMAND}\``,
      };
    }
    return {
      kind: "problem",
      detail: `\`${command} ${GH_TOKEN_ARGS.join(" ")}\` could not be run (${run.error.message})`,
      fix: `run \`${command} ${GH_TOKEN_ARGS.join(" ")}\` by hand and fix what it reports`,
    };
  }

  // stdout is the credential. Only stderr is ever quoted back.
  const token = (run.stdout ?? "").trim();
  if (run.status !== 0) {
    const said = firstLine(run.stderr);
    // gh's own documented code for "authentication is needed", which is
    // the overwhelmingly likely one here and the only one with a fix
    // worth naming on its own.
    const detail =
      run.status === 4
        ? `\`${command}\` is installed but not logged in to ${GH_HOSTNAME}`
        : `\`${command} ${GH_TOKEN_ARGS.join(" ")}\` failed${said === "" ? "" : ` (${said})`}`;
    return { kind: "problem", detail, fix: GH_LOGIN_COMMAND };
  }
  if (token.length === 0) {
    return {
      kind: "problem",
      detail: `\`${command} ${GH_TOKEN_ARGS.join(" ")}\` printed no token, so there is no ${GH_HOSTNAME} login to use`,
      fix: GH_LOGIN_COMMAND,
    };
  }
  return { kind: "token", token };
}

/**
 * The whole refusal a task prints when a project configured for the
 * `gh` login cannot be given one - what is wrong, the command that fixes
 * it, and why no other credential is reached for instead.
 *
 * Exported so `fabrica doctor`'s project line, `fabrica do`'s start gate
 * and the handoff's own last-moment check all say the same thing about
 * the same finding (the `detail` and the `fix` are shared verbatim;
 * doctor prints them as its one line, a refusal prints this paragraph).
 */
export function ghLoginRefusal(recordHome: string, label: string, problem: GhProblem): string {
  return (
    `${label} is configured to reach GitHub with the gh login (githubToken = "gh" in ` +
    `${projectsTomlPath(recordHome)}), but ${problem.detail}. Fix it with \`${problem.fix}\`, then confirm with ` +
    `\`fabrica doctor\`. Fabrica does not fall back to a stored token or to the GitHub App for such a project: ` +
    `the gh login is either this project's credential or it is not, and quietly swapping one for the other would ` +
    `publish under a credential nobody chose.`
  );
}

/** gh's own first line of complaint, for a failure it did not give an
 * exit code of its own. One line, because this ends up inside a single
 * doctor line - and `stderr`, never `stdout`. */
function firstLine(stderr: string | undefined): string {
  return (stderr ?? "").trim().split("\n")[0]?.trim() ?? "";
}
