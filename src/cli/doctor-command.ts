// `fabrica doctor` (Client ruling 2026-10-10): a preflight that spends
// nothing. One line per check, OK or FAIL with the exact fix, and a
// non-zero exit on any FAIL. `--live` adds the one check that does spend:
// a minimal real call with the worker token (a few cents), reported as
// alive or dead. No check ever prints a token.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  capsActive,
  describeUnmeasured,
  githubTokenStatus,
  inspectorBranchStatus,
  probeWorkerToken,
  readEvents,
  requireGitRoot,
  unmeasuredSpend,
  workerImageStatus,
  workerTokenStatus,
} from "../index.ts";
import { CliError } from "./errors.ts";
import { loadConfigOrDefault } from "./load-config.ts";
import { resolveRecordHome } from "./record-home.ts";

export const DOCTOR_USAGE = "fabrica doctor [--live]";

export const DOCTOR_HELP = `Usage: ${DOCTOR_USAGE}

Checks, without spending anything, that this machine can run tasks: Node,
the copy of fabrica actually running - a developer checkout (branch,
commit) or an installed copy (version, commit), either way compared
against origin/master - Docker, the worker image, the worker token, the
GitHub token Inspector needs, Inspector itself, every registered project,
the caps, and any SPEND UNKNOWN block. One line per check - OK, or FAIL
with the exact fix. Exits non-zero if anything fails.

  --live  Also make one minimal real call with the worker token (a few
          cents) and report whether it is alive or dead.

Environment:
  FABRICA_HOME  Overrides the record home (default: ~/.fabrica).
`;

export interface DoctorCheck {
  ok: boolean;
  label: string;
  detail: string;
  fix?: string;
}

/** The machine-level checks, injectable so tests never depend on this
 * machine's Docker, tokens, or PATH. */
export interface DoctorProbes {
  node(): DoctorCheck;
  checkout(): DoctorCheck;
  docker(): DoctorCheck;
  workerImage(): DoctorCheck;
  workerToken(recordHome: string): DoctorCheck;
  githubToken(): DoctorCheck;
  inspector(): DoctorCheck;
  live(recordHome: string): Promise<DoctorCheck>;
}

const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** `fabrica` can run from two different kinds of copy (issue: installable
 * from zero): a developer's own checkout, linked in with `npm link` (has
 * a real `.git`, lives on a branch, moves every time the checkout does),
 * or a frozen copy `npm install -g github:inactdev/fabrica` extracted
 * (no `.git` at all - npm's packing strips it, and sets no `gitHead`
 * either, verified against a real global install - so its commit comes
 * from `build-info.json` instead, written at `prepare` time by
 * `scripts/write-build-info.mjs` while `.git` still existed, before that
 * strip). */
export interface CopyInfo {
  kind: "dev-checkout" | "installed";
  root: string;
  branch: string | null;
  commit: string | null;
  version: string;
}

const UPSTREAM_REPO = "https://github.com/inactdev/fabrica.git";

/** The Node version the check box runs - .inspector.json's image tag - is
 * the one this suite is known to pass on. */
export function nodeCheck(actual: string, expected: string | null): DoctorCheck {
  const label = "node";
  if (expected === null) return { ok: true, label, detail: `${actual} (no pinned version found to compare with)` };
  const have = actual.replace(/^v/, "");
  return have === expected
    ? { ok: true, label, detail: `v${have}, the version the check box runs` }
    : { ok: false, label, detail: `v${have}, but the check box runs ${expected}`, fix: `install Node ${expected}` };
}

function short(sha: string | null): string {
  return sha ? sha.slice(0, 12) : "unknown";
}

/** Pure wording/pass-fail, so every case is testable without touching
 * real git or the network - `remoteMasterCommit` is `null` when that
 * lookup itself failed (no network, no git), which is reported but
 * never fails the check: an older commit still runs correctly, it is
 * only ever information here, not a fix-required state. */
export function checkoutCheck(copy: CopyInfo, remoteMasterCommit: string | null): DoctorCheck {
  const label = "checkout";
  const behindNote =
    remoteMasterCommit === null
      ? "can't check against origin/master (no network, or git unavailable)"
      : copy.commit === remoteMasterCommit
        ? "up to date with origin/master"
        : `behind origin/master, latest is ${short(remoteMasterCommit)}`;

  if (copy.kind === "installed") {
    if (copy.commit === null) {
      return {
        ok: false,
        label,
        detail: `installed copy at ${copy.root} has no build-info.json, so its commit is unknown`,
        fix: "reinstall with: npm install -g github:inactdev/fabrica",
      };
    }
    return { ok: true, label, detail: `installed copy v${copy.version}, commit ${short(copy.commit)} (${behindNote})` };
  }

  const detail = `fabrica runs from ${copy.root} on ${copy.branch || "a detached HEAD"}, commit ${short(copy.commit)} (${behindNote})`;
  return copy.branch === "master"
    ? { ok: true, label, detail }
    : { ok: false, label, detail: `${detail}, not master`, fix: `git -C ${copy.root} checkout master && git -C ${copy.root} pull` };
}

function pinnedNodeVersion(): string | null {
  try {
    const image = (JSON.parse(readFileSync(join(CHECKOUT, ".inspector.json"), "utf8")) as { image?: string }).image ?? "";
    return /node:(\d+\.\d+\.\d+)/.exec(image)?.[1] ?? null;
  } catch {
    return null;
  }
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function readPackageVersion(root: string): string {
  try {
    return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function readBuildInfoCommit(root: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(root, "build-info.json"), "utf8")) as { commit?: string | null }).commit ?? null;
  } catch {
    return null;
  }
}

/** `.git` (directory, or a worktree's gitdir-pointer file - either way
 * `existsSync` alone is enough to tell a real checkout from a packed
 * copy) decides which kind of copy this is - the ground truth npm's own
 * install behavior already establishes, not a flag anything has to keep
 * in sync by hand. */
export function detectCopy(root: string, gitIn: (args: string[]) => string | null): CopyInfo {
  const version = readPackageVersion(root);
  if (existsSync(join(root, ".git"))) {
    return {
      kind: "dev-checkout",
      root,
      branch: gitIn(["branch", "--show-current"]) ?? "",
      commit: gitIn(["rev-parse", "HEAD"]),
      version,
    };
  }
  return { kind: "installed", root, branch: null, commit: readBuildInfoCommit(root), version };
}

/** The one value `fabrica doctor`'s own "checkout" line reports as this
 * copy's commit (dev checkout: live `git rev-parse HEAD`; installed:
 * `build-info.json`'s recorded commit, or null if that file is
 * missing) - exported so anything else that needs to know "what commit
 * is this running copy" (the live view's own `/api/version`, `fabrica
 * up`'s stale-live-view check) asks this exact question rather than
 * reimplementing detectCopy's dev-checkout-vs-installed branch itself. */
export function runningCopyCommit(root: string): string | null {
  return detectCopy(root, (args) => git(root, args)).commit;
}

/** One lightweight network call, no local repo required either side
 * (works identically for a dev checkout or an installed copy) and no
 * mutation of any local ref - a `git fetch` would learn the exact
 * ahead/behind count but updates `.git/refs/remotes/origin/master`,
 * which doctor (claims to, and should) never touch. */
function fetchRemoteMasterCommit(): string | null {
  try {
    const out = execFileSync("git", ["ls-remote", UPSTREAM_REPO, "master"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

export const realProbes: DoctorProbes = {
  node: () => nodeCheck(process.version, pinnedNodeVersion()),
  checkout: () => checkoutCheck(detectCopy(CHECKOUT, (args) => git(CHECKOUT, args)), fetchRemoteMasterCommit()),
  docker() {
    try {
      execFileSync("docker", ["info"], { stdio: "ignore", timeout: 20_000 });
      return { ok: true, label: "docker", detail: "reachable" };
    } catch {
      return { ok: false, label: "docker", detail: "not reachable", fix: "start Docker (e.g. open -a Docker), then try again" };
    }
  },
  workerImage: () => workerImageStatus(),
  workerToken: (recordHome) => workerTokenStatus(process.env, recordHome),
  githubToken: () => githubTokenStatus(process.env),
  inspector: () => inspectorBranchStatus(process.env),
  live: (recordHome) => probeWorkerToken(process.env, recordHome),
};

function projectCheck(name: string, path: string): DoctorCheck {
  const label = `project ${name}`;
  try {
    requireGitRoot(path);
  } catch (err) {
    // requireGitRoot's message is "<what is wrong>. <how to fix it>".
    const message = err instanceof Error ? err.message : String(err);
    const cut = message.indexOf(". ");
    return cut === -1
      ? { ok: false, label, detail: message }
      : { ok: false, label, detail: message.slice(0, cut), fix: message.slice(cut + 2) };
  }
  if (!existsSync(join(path, ".inspector.json")) && !existsSync(join(path, "check.sh"))) {
    return {
      ok: false,
      label,
      detail: `${path} has neither .inspector.json nor check.sh, so nothing can check a task's work`,
      fix: "commit a check.sh (and an .inspector.json, for Inspector) at the project's root",
    };
  }
  if (git(path, ["remote", "get-url", "origin"]) === null) {
    return {
      ok: false,
      label,
      detail: `${path} has no origin remote, so Inspector has nowhere to publish`,
      fix: `git -C ${path} remote add origin <url>`,
    };
  }
  return { ok: true, label, detail: `${path}: git root, has a check, has origin` };
}

function parseDoctorArgs(argv: string[]): { live: boolean } {
  let live = false;
  for (const arg of argv) {
    if (arg === "--live") live = true;
    else throw new CliError("bad-usage", `fabrica doctor: unknown argument "${arg}". Usage: ${DOCTOR_USAGE}`);
  }
  return { live };
}

export interface RunDoctorCommandOptions {
  recordHome?: string;
  probes?: DoctorProbes;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/** Returns the process exit code - never throws. */
export async function runDoctorCommand(argv: string[], opts: RunDoctorCommandOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? ((line: string) => console.log(line));
  const stderr = opts.stderr ?? ((line: string) => console.error(line));
  let live: boolean;
  try {
    ({ live } = parseDoctorArgs(argv));
  } catch (err) {
    stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const recordHome = opts.recordHome ?? resolveRecordHome();
  const probes = opts.probes ?? realProbes;

  const checks: DoctorCheck[] = [
    probes.node(),
    probes.checkout(),
    probes.docker(),
    probes.workerImage(),
    probes.workerToken(recordHome),
    probes.githubToken(),
    probes.inspector(),
  ];

  let config;
  try {
    config = loadConfigOrDefault(recordHome);
  } catch (err) {
    checks.push({ ok: false, label: "projects.toml", detail: err instanceof Error ? err.message : String(err), fix: "fix projects.toml" });
  }
  if (config) {
    const names = Object.keys(config.projects);
    if (names.length === 0) {
      checks.push({ ok: false, label: "projects", detail: "no projects are registered", fix: `add a [projects.<name>] entry to ${recordHome}/projects.toml` });
    }
    for (const name of names) checks.push(projectCheck(name, config.projects[name].path));

    const { perTaskUsd, perDayUsd } = config.caps;
    checks.push(
      capsActive(config.caps)
        ? { ok: true, label: "caps", detail: `perTaskUsd = ${perTaskUsd ?? "unset"}, perDayUsd = ${perDayUsd ?? "unset"}` }
        : { ok: false, label: "caps", detail: "no spending cap is set", fix: `add a [caps] table (perTaskUsd, perDayUsd) to ${recordHome}/projects.toml` }
    );

    const unmeasured = unmeasuredSpend(readEvents(recordHome));
    if (unmeasured.length > 0 && capsActive(config.caps)) {
      checks.push({
        ok: false,
        label: "spend",
        detail: "SPEND UNKNOWN - tasks blocked",
        fix: describeUnmeasured(unmeasured).join("; "),
      });
    } else {
      checks.push({ ok: true, label: "spend", detail: unmeasured.length > 0 ? `${unmeasured.length} unmeasured, not blocking (no cap set)` : "no unmeasured spend" });
    }
  }

  if (live) checks.push(await probes.live(recordHome));

  for (const check of checks) {
    stdout(check.ok ? `OK   ${check.label}: ${check.detail}` : `FAIL ${check.label}: ${check.detail}${check.fix ? ` - fix: ${check.fix}` : ""}`);
  }
  return checks.every((c) => c.ok) ? 0 : 1;
}
