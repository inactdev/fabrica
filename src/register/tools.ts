// The four things `fabrica register` cannot do with git alone: ask
// whether `gh` is usable, ask whether Docker is up, run the project's
// check inside the Client's chosen image, and open the pull request.
//
// They sit behind one interface so the rest of this module - the
// prerequisite order, the temporary worktree, the commit, the push, the
// teardown, the projects.toml write - is exercisable for real in a test
// against a throwaway repository with a local bare origin, with no
// Docker daemon, no GitHub account and no network. Git itself stays real
// everywhere, the same way src/line's own tests run real git.

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ContainmentError, runContained } from "../containment/index.ts";
import { resolveCommonGitDir, writeSanitizedGitConfig } from "../line/index.ts";
import { commandIsInstalled } from "../inspector/index.ts";
import type { BoxCheckResult } from "../brain/index.ts";
import type { ReadOnlyMount } from "../containment/index.ts";

/** A prerequisite's answer: usable, or not usable and why. `fix` is the
 * exact next command when there is one. */
export interface PrerequisiteResult {
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface PullRequestResult {
  /** The pull request's URL, when one was opened. */
  url: string | null;
  /** gh's own output, for the refusal message when url is null. */
  message: string;
}

export interface RegisterTools {
  /** Is `gh` installed, and logged in to `host`? `host` is null for an
   * origin with no host (a local path), where there is nothing to scope
   * the check to. */
  ghStatus(host: string | null): PrerequisiteResult;
  /** Is the Docker daemon reachable? */
  dockerStatus(): PrerequisiteResult;
  /**
   * Runs `command` inside `image`, against `workdir` - never on the
   * host (issue #64's ruling, which this command is bound by exactly as
   * a worker's own check is). Reports "could not run" separately from
   * "ran and failed", so a missing image is never read as a red check.
   */
  runCheck(opts: { workdir: string; image: string; command: string }): Promise<BoxCheckResult>;
  /** Opens the pull request from an already-pushed branch. */
  openPullRequest(opts: {
    worktree: string;
    base: string;
    head: string;
    title: string;
    body: string;
  }): PullRequestResult;
}

function firstLine(value: string): string {
  return value.trim().split("\n")[0] ?? "";
}

function failureOutput(err: unknown): string {
  const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
  const stderr = e?.stderr?.toString().trim();
  if (stderr && stderr.length > 0) return stderr;
  const stdout = e?.stdout?.toString().trim();
  if (stdout && stdout.length > 0) return stdout;
  return e?.message ?? String(err);
}

function realGhStatus(host: string | null): PrerequisiteResult {
  if (!commandIsInstalled("gh", process.env)) {
    return {
      ok: false,
      detail: "the GitHub CLI (gh) is not on PATH, and register opens the pull request with it",
      fix: "install the GitHub CLI (https://cli.github.com), then run `gh auth login`",
    };
  }
  // Always scoped to origin's own host when there is one: `gh auth
  // status` exits 1 if ANY stored account on ANY host has a problem, so
  // an unrelated stale token would otherwise read as "not logged in"
  // (gh's own manual names --hostname as the fix for exactly this).
  const args = host === null ? ["auth", "status"] : ["auth", "status", "--hostname", host];
  try {
    execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, detail: host === null ? "gh is installed and logged in" : `gh is logged in to ${host}` };
  } catch (err) {
    return {
      ok: false,
      detail: `\`gh ${args.join(" ")}\` failed: ${firstLine(failureOutput(err))}`,
      fix: host === null ? "run `gh auth login`" : `run \`gh auth login --hostname ${host}\``,
    };
  }
}

function realDockerStatus(): PrerequisiteResult {
  try {
    execFileSync("docker", ["info"], { stdio: ["ignore", "ignore", "pipe"] });
    return { ok: true, detail: "the Docker daemon is reachable" };
  } catch (err) {
    return {
      ok: false,
      detail: `\`docker info\` failed: ${firstLine(failureOutput(err))}`,
      fix: "start Docker (or install it), then try again - register runs your check inside a container, never on this machine",
    };
  }
}

/** The read-only git mounts a contained command needs to use git at all:
 * the worktree's shared .git, with a sanitized, credential-free `config`
 * shadowed over the real one. The same pair a worker's own box gets - see
 * src/containment/README.md for why the config is never the real file. */
function gitMounts(workdir: string): { readOnlyMounts: ReadOnlyMount[]; sanitizedConfigDir: string } {
  const commonGitDir = resolveCommonGitDir(workdir);
  const sanitizedConfig = writeSanitizedGitConfig(commonGitDir);
  return {
    readOnlyMounts: [commonGitDir, { source: sanitizedConfig, target: join(commonGitDir, "config") }],
    sanitizedConfigDir: dirname(sanitizedConfig),
  };
}

async function realRunCheck(opts: { workdir: string; image: string; command: string }): Promise<BoxCheckResult> {
  let mounts: { readOnlyMounts: ReadOnlyMount[]; sanitizedConfigDir: string };
  try {
    mounts = gitMounts(opts.workdir);
  } catch (err) {
    return { ran: false, reason: `could not prepare the container: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    const { stdout, stderr, exitCode } = await runContained("sh", ["-c", opts.command], {
      workdir: opts.workdir,
      // Allowed for the same reason a worker's own check box allows it:
      // a real project's check installs dependencies.
      network: "allowed",
      image: opts.image,
      readOnlyMounts: mounts.readOnlyMounts,
    });
    return { ran: true, exitCode: exitCode ?? -1, output: [stdout, stderr].filter((s) => s.length > 0).join("\n") };
  } catch (err) {
    if (err instanceof ContainmentError) {
      return { ran: false, reason: `could not start a container from image ${opts.image}: ${err.message}` };
    }
    throw err;
  } finally {
    rmSync(mounts.sanitizedConfigDir, { recursive: true, force: true });
  }
}

/** The URL of a pull request in gh's output, if it printed one. */
export function pullRequestUrlIn(output: string): string | null {
  const match = output.match(/https?:\/\/\S*\/pull\/\d+/);
  return match ? match[0] : null;
}

function realOpenPullRequest(opts: {
  worktree: string;
  base: string;
  head: string;
  title: string;
  body: string;
}): PullRequestResult {
  // --body-file, not --body: a multi-line body through argv is exactly
  // the case gh's own manual recommends a file for. --title plus a body
  // plus --base plus --head is what makes the call fully
  // non-interactive; --head in particular is what stops gh offering to
  // push or fork the branch itself, which it must never do here - the
  // push already happened, as the Client, with his own credentials.
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "fabrica-register-pr-"));
  const bodyFile = join(dir, "body.md");
  writeFileSync(bodyFile, opts.body);
  const args = [
    "pr",
    "create",
    "--base",
    opts.base,
    "--head",
    opts.head,
    "--title",
    opts.title,
    "--body-file",
    bodyFile,
  ];
  try {
    const stdout = execFileSync("gh", args, {
      cwd: opts.worktree,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { url: pullRequestUrlIn(stdout), message: stdout.trim() };
  } catch (err) {
    // gh's documented sharp edge: it can exit non-zero having already
    // printed the new pull request's URL. Refusing on the exit code
    // alone would tell the Client nothing was opened when something was,
    // so a URL in the output wins over the status.
    const output = failureOutput(err);
    return { url: pullRequestUrlIn(output), message: output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const realRegisterTools: RegisterTools = {
  ghStatus: realGhStatus,
  dockerStatus: realDockerStatus,
  runCheck: realRunCheck,
  openPullRequest: realOpenPullRequest,
};
