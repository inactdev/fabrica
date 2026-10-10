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
the checkout the fabrica command runs from, Docker, the worker image, the
worker token, the GitHub token Inspector needs, Inspector itself, every
registered project, the caps, and any SPEND UNKNOWN block. One line per
check - OK, or FAIL with the exact fix. Exits non-zero if anything fails.

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

export function checkoutCheck(root: string, branch: string): DoctorCheck {
  const label = "checkout";
  const detail = `fabrica runs from ${root} on ${branch || "a detached HEAD"}`;
  return branch === "master"
    ? { ok: true, label, detail }
    : { ok: false, label, detail: `${detail}, not master`, fix: `git -C ${root} checkout master && git -C ${root} pull` };
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

export const realProbes: DoctorProbes = {
  node: () => nodeCheck(process.version, pinnedNodeVersion()),
  checkout: () => checkoutCheck(CHECKOUT, git(CHECKOUT, ["branch", "--show-current"]) ?? ""),
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
