// The local Inspector handoff. Inspector owns independent checks and, once
// inspector#18 lands, publishing a green branch. Fabrica only translates
// its process result into the three verdicts the Foreman records.

import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { Inspection, Inspector } from "./types.ts";

export const INSPECTOR_CONFIG = ".inspector.json";
export const MAX_INSPECTION_REPORT_BYTES = 16 * 1024;

export function inspectorIsConfigured(workdir: string, revision?: string): boolean {
  if (revision === undefined) return existsSync(join(workdir, INSPECTOR_CONFIG));
  return (
    execFileSync("git", ["ls-tree", "--name-only", revision, "--", INSPECTOR_CONFIG], {
      cwd: workdir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim() === INSPECTOR_CONFIG
  );
}

export function inspectorConfigMatches(workdir: string, baseRevision: string): boolean {
  try {
    const blobAt = (revision: string) =>
      execFileSync("git", ["rev-parse", "--verify", `${revision}:${INSPECTOR_CONFIG}`], {
        cwd: workdir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    return blobAt(baseRevision) === blobAt("HEAD");
  } catch {
    return false;
  }
}

/** The production adapter for the Inspector command installed on PATH. */
export function defaultInspector(): Inspector {
  return inspectorAdapter();
}

/** Allows tests to run a throwaway command without invoking real Inspector. */
export interface InspectorAdapterOptions {
  /** The environment the inspector child starts from. Defaults to
   * Fabrica's own; never modified. */
  env?: NodeJS.ProcessEnv;
}

export function inspectorAdapter(command: string = "inspector", opts: InspectorAdapterOptions = {}): Inspector {
  const baseEnv = opts.env ?? process.env;
  // Resolved once per adapter, then reused for every inspection: the
  // child's environment only, never Fabrica's own.
  let childEnv: NodeJS.ProcessEnv | undefined;
  const ensureEnv = (): NodeJS.ProcessEnv => (childEnv ??= { ...baseEnv, GITHUB_TOKEN: githubToken(baseEnv) });
  return {
    async inspect({ branch, workdir }) {
      let env: NodeJS.ProcessEnv;
      try {
        env = ensureEnv();
      } catch (err) {
        return { verdict: "refused", report: err instanceof Error ? err.message : String(err) };
      }
      return runInspector(command, workdir, branch, env);
    },
    installed() {
      return commandIsInstalled(command, baseEnv);
    },
    prepare() {
      ensureEnv();
    },
  };
}

/** Inspector needs GITHUB_TOKEN to publish a green result (issue #103).
 * Fabrica's own environment wins; otherwise `gh auth token` is asked
 * once. The value is only ever returned - never printed, logged, or put
 * in Fabrica's own process environment. */
function githubToken(env: NodeJS.ProcessEnv): string {
  return resolveGithubToken(env).token;
}

/** The token Inspector will get, and where it came from - never printed. */
export function resolveGithubToken(env: NodeJS.ProcessEnv): { token: string; source: "GITHUB_TOKEN" | "gh auth token" } {
  if (env.GITHUB_TOKEN && env.GITHUB_TOKEN.trim().length > 0) return { token: env.GITHUB_TOKEN, source: "GITHUB_TOKEN" };
  let token = "";
  try {
    token = execFileSync("gh", ["auth", "token"], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // gh missing, or not logged in - both answered by the same message.
  }
  if (token.length === 0) {
    throw new Error(
      "Inspector needs a GitHub token to publish a green result, and none was found: GITHUB_TOKEN is not " +
        "set and `gh auth token` gave nothing (gh is missing or not logged in). Run `gh auth login`, then " +
        "start the task again. Nothing was started."
    );
  }
  return { token, source: "gh auth token" };
}

/** Whether `command` names an executable: a path as given, a bare name on
 * PATH. Looked up without running anything. */
export function commandIsInstalled(command: string, env: NodeJS.ProcessEnv): boolean {
  const candidates =
    isAbsolute(command) || command.includes("/")
      ? [command]
      : (env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, command));
  return candidates.some((path) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

interface OutputTail {
  total: number;
  tail: Buffer;
}

function appendOutput(output: OutputTail, chunk: Buffer): void {
  output.total += chunk.byteLength;
  if (chunk.byteLength >= MAX_INSPECTION_REPORT_BYTES) {
    output.tail = chunk.subarray(chunk.byteLength - MAX_INSPECTION_REPORT_BYTES);
    return;
  }
  const combined = Buffer.concat([output.tail, chunk]);
  output.tail =
    combined.byteLength <= MAX_INSPECTION_REPORT_BYTES
      ? combined
      : combined.subarray(combined.byteLength - MAX_INSPECTION_REPORT_BYTES);
}

function outputReport(stdout: OutputTail, stderr: OutputTail, exitCode: number | null): string {
  const separator = stdout.total > 0 && stderr.total > 0 ? Buffer.from("\n") : Buffer.alloc(0);
  const total = stdout.total + separator.byteLength + stderr.total;
  if (total === 0) return `Inspector exited ${exitCode ?? "after a signal"}.`;

  const available = Buffer.concat([stdout.tail, separator, stderr.tail]);
  const tail =
    available.byteLength <= MAX_INSPECTION_REPORT_BYTES
      ? available
      : available.subarray(available.byteLength - MAX_INSPECTION_REPORT_BYTES);
  return boundedReport(tail, total, true) || `Inspector exited ${exitCode ?? "after a signal"}.`;
}

async function runInspector(
  command: string,
  workdir: string,
  branch: string,
  env: NodeJS.ProcessEnv
): Promise<Inspection> {
  const result = await new Promise<{
    stdout: OutputTail;
    stderr: OutputTail;
    exitCode: number | null;
    error?: Error;
  }>((resolve) => {
    // -branch is required by Inspector: the one branch it may publish to
    // after a green result. Without it, Inspector refuses every handoff.
    const child = spawn(command, ["-repo", workdir, "-branch", branch], {
      cwd: workdir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: OutputTail = { total: 0, tail: Buffer.alloc(0) };
    const stderr: OutputTail = { total: 0, tail: Buffer.alloc(0) };
    let settled = false;

    child.stdout.on("data", (chunk: Buffer) => appendOutput(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => appendOutput(stderr, chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      resolve({ stdout, stderr, exitCode: null, error });
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      resolve({ stdout, stderr, exitCode });
    });
  });

  if (result.error) {
    return { verdict: "refused", report: `Inspector could not start: ${result.error.message}` };
  }

  const report = outputReport(result.stdout, result.stderr, result.exitCode);
  if (result.exitCode === 0) return { verdict: "green", report };
  if (result.exitCode === 1) return { verdict: "red", report };
  return { verdict: "refused", report };
}

function boundedReport(tailBuffer: Buffer, total: number, trimComplete: boolean = false): string {
  if (total <= MAX_INSPECTION_REPORT_BYTES) {
    const complete = tailBuffer.toString("utf8");
    return trimComplete ? complete.trim() : complete;
  }

  const marker = (kept: number) => `[truncated, showing last ${kept} of ${total} bytes]\n`;
  const maxTail = MAX_INSPECTION_REPORT_BYTES - Buffer.byteLength(marker(MAX_INSPECTION_REPORT_BYTES), "utf8");
  const tail = tailBuffer
    .subarray(Math.max(0, tailBuffer.byteLength - maxTail))
    .toString("utf8")
    .replace(/^\uFFFD+/, "");
  const kept = Buffer.byteLength(tail, "utf8");
  return `${marker(kept)}${tail}`;
}

/** Bounds stored output while keeping Inspector's final diagnosis. */
export function reportForRecord(report: string): string {
  const content = Buffer.from(report, "utf8");
  return boundedReport(content, content.byteLength);
}
