// The local Inspector handoff. Inspector owns independent checks and, once
// inspector#18 lands, publishing a green branch. Fabrica only translates
// its process result into the three verdicts the Foreman records.

import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { Inspection, Inspector } from "./types.ts";
// Type only, erased at compile time: settling a reviewer needs the
// Worker's own vendor, which this module has no business knowing about
// (src/reviewer/resolve.ts's header).
import type { ResolvedReviewer } from "../reviewer/index.ts";
// Type only, for the same reason: minting a publishing token needs the
// task's repository and the two permissions that call needs, neither of
// which is this adapter's business (src/githubapp/minter.ts).
import type { ScopedToken } from "../githubapp/index.ts";

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

/**
 * Whether `.inspector.json` - as it stands at `revision`, or in the
 * working tree when none is given - declares `testPaths`, the key that
 * turns on Inspector's second, model-judged half and so makes a
 * reviewer mandatory (src/reviewer/resolve.ts).
 *
 * Read through git rather than the filesystem whenever a revision is
 * named, for the same reason `inspectorIsConfigured` is: the question
 * is always about a particular commit, never about whatever the Client
 * happens to have checked out. Anything unreadable or not valid JSON
 * answers `false` - an unparseable config is Inspector's own refusal to
 * make, not a reason for Fabrica to demand a reviewer.
 */
export function declaresTestPaths(workdir: string, revision?: string): boolean {
  let text: string;
  try {
    text =
      revision === undefined
        ? readFileSync(join(workdir, INSPECTOR_CONFIG), "utf8")
        : execFileSync("git", ["show", `${revision}:${INSPECTOR_CONFIG}`], {
            cwd: workdir,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          });
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const testPaths = (parsed as Record<string, unknown>).testPaths;
  return Array.isArray(testPaths) ? testPaths.length > 0 : typeof testPaths === "string" && testPaths.length > 0;
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
export function defaultInspector(opts: InspectorAdapterOptions = {}): Inspector {
  return inspectorAdapter("inspector", opts);
}

/** Allows tests to run a throwaway command without invoking real Inspector. */
export interface InspectorAdapterOptions {
  /** The environment the inspector child starts from. Defaults to
   * Fabrica's own; never modified. */
  env?: NodeJS.ProcessEnv;
  /** Who judges this project's test changes (src/reviewer/resolve.ts).
   * Omitted, Inspector is called exactly as it was before: no
   * `-vendor`/`-model`, no reviewer credential in its environment. */
  reviewer?: ResolvedReviewer;
  /** Where the `GITHUB_TOKEN` Inspector publishes with comes from
   * (issue #187): a GitHub App token minted for this task's repository
   * alone, with only `contents: write`, `pull_requests: write` and `statuses: write` (the stamp), for
   * this one handoff. Already bound to that repository and those
   * permissions by the caller (`src/githubapp`'s `scopedToken`), so
   * this adapter never learns either.
   *
   * Omitted, every handoff refuses. There is deliberately no fallback:
   * the Client's personal token is gone from the configuration, and a
   * handoff that silently published with some other credential would be
   * exactly the breadth the App exists to remove. */
  token?: ScopedToken;
}

/** The message a handoff refuses with when it was built with no token
 * source at all - a wiring mistake rather than a machine the Client has
 * to fix, so it says which seam is missing. */
const NO_TOKEN_SOURCE =
  "Inspector was handed no GitHub App to mint a publishing token from, so it cannot push or open a pull " +
  "request. This is a wiring fault in Fabrica, not a setting on this machine: every Inspector handoff is " +
  "built with a scoped token source (src/foreman/judge.ts).";

export function inspectorAdapter(command: string = "inspector", opts: InspectorAdapterOptions = {}): Inspector {
  const baseEnv = opts.env ?? process.env;
  const reviewer = opts.reviewer;
  const token = opts.token;
  // The reviewer's key rides on the child's environment for the same
  // reason the GitHub token does - an argv entry is visible to every
  // process on the machine, an environment entry on a child Fabrica
  // spawned is not. Fabrica's own environment is never modified.
  //
  // Unlike the reviewer's, the GitHub token is minted per inspection
  // rather than once per adapter: it lives an hour, and a fix round
  // reached days after the first pass must not try to publish with a
  // token minted for the first one.
  const childEnv = (githubToken: string): NodeJS.ProcessEnv => ({
    ...baseEnv,
    GITHUB_TOKEN: githubToken,
    ...(reviewer === undefined ? {} : { [reviewer.apiKeyVar]: reviewer.apiKey }),
    ...(reviewer?.baseUrl === undefined ? {} : { [reviewer.baseUrlVar]: reviewer.baseUrl }),
  });
  return {
    async inspect({ branch, workdir, prTitle, prBody, expectedTip }) {
      if (token === undefined) return { verdict: "refused", report: NO_TOKEN_SOURCE };
      let env: NodeJS.ProcessEnv;
      try {
        env = childEnv((await token.mint()).token);
      } catch (err) {
        return { verdict: "refused", report: err instanceof Error ? err.message : String(err) };
      }
      return runInspector(command, workdir, branch, env, prTitle, prBody, expectedTip, reviewer);
    },
    installed() {
      return commandIsInstalled(command, baseEnv);
    },
    prepare() {
      // Synchronous and offline on purpose: this is what refuses a task
      // before any worker starts, and the whole of "could this handoff
      // ever work" that can be answered without a network call - both
      // App settings present, the key file at mode 600, and parsable.
      // The mint itself happens in `inspect`, which is already async.
      if (token === undefined) throw new Error(NO_TOKEN_SOURCE);
      token.check();
    },
  };
}

/** Where `command` resolves to as an executable - a path as given, a bare
 * name against PATH - or `null` when nothing there is executable. Looked
 * up without running anything. Exported because a check that reports
 * *which build* of Inspector is installed has to name the file it read
 * (`go version -m <path>`), not just know that one exists. */
export function resolveCommandPath(command: string, env: NodeJS.ProcessEnv): string | null {
  const candidates =
    isAbsolute(command) || command.includes("/")
      ? [command]
      : (env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, command));
  return (
    candidates.find((path) => {
      try {
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }) ?? null
  );
}

/** Whether `command` names an executable: a path as given, a bare name on
 * PATH. Looked up without running anything. */
export function commandIsInstalled(command: string, env: NodeJS.ProcessEnv): boolean {
  return resolveCommandPath(command, env) !== null;
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

/** The exact line Inspector prints on its own stdout once it has opened a
 * pull request - the only signal "pr-opened" is ever appended from. Read
 * from the bounded stdout tail already captured for the report, rather
 * than a second, unbounded copy of stdout kept just to search it. */
export function extractPrUrl(stdout: string): string | undefined {
  const matches = [...stdout.matchAll(/^pull request:\s*(\S+)\s*$/gm)];
  return matches.length > 0 ? matches[matches.length - 1][1] : undefined;
}

async function runInspector(
  command: string,
  workdir: string,
  branch: string,
  env: NodeJS.ProcessEnv,
  prTitle?: string,
  prBody?: string,
  expectedTip?: string,
  reviewer?: ResolvedReviewer
): Promise<Inspection> {
  // -branch is required by Inspector: the one branch it may publish to
  // after a green result. Without it, Inspector refuses every handoff.
  const args = ["-repo", workdir, "-branch", branch];
  // Only when the caller has one: a publish with no lease is what
  // Inspector has always done, and a missing expected tip must never be
  // dressed up as an empty one, which would lease against "no branch".
  if (expectedTip !== undefined) args.push("-expected-tip", expectedTip);
  // The reviewer, when one is configured, goes on every call rather
  // than only on a project whose .inspector.json declares testPaths:
  // testPaths is what makes a reviewer *required*, not what makes one
  // usable, and Inspector ignores a reviewer it has nothing to judge.
  // The key itself never appears here - only in the child's env.
  if (reviewer !== undefined) args.push("-vendor", reviewer.vendor, "-model", reviewer.model);
  if (prTitle !== undefined) args.push("-pr-title", prTitle);
  // prBody travels as a file, not an argument: a pull request body is
  // free-form, multi-line text, which an argv entry cannot carry safely
  // across every shell/spawn implementation.
  let prBodyDir: string | undefined;
  if (prBody !== undefined) {
    prBodyDir = mkdtempSync(join(tmpdir(), "fabrica-inspector-pr-"));
    const prBodyFile = join(prBodyDir, "pr-body.md");
    writeFileSync(prBodyFile, prBody);
    args.push("-pr-body-file", prBodyFile);
  }

  try {
    const result = await new Promise<{
      stdout: OutputTail;
      stderr: OutputTail;
      exitCode: number | null;
      error?: Error;
    }>((resolve) => {
      const child = spawn(command, args, {
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
    const prUrl = extractPrUrl(result.stdout.tail.toString("utf8"));
    const withPrUrl = (base: Inspection): Inspection => (prUrl !== undefined ? { ...base, prUrl } : base);
    if (result.exitCode === 0) return withPrUrl({ verdict: "green", report });
    if (result.exitCode === 1) return withPrUrl({ verdict: "red", report });
    return withPrUrl({ verdict: "refused", report });
  } finally {
    if (prBodyDir) rmSync(prBodyDir, { recursive: true, force: true });
  }
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
