// Empirically proves what a shipped settings.json's permissions.allow/
// deny actually do against a real, non-interactive session of this
// harness - not just what the documented pattern-matching rules say
// should happen. A real headless session has no TTY to answer an
// approval prompt, so anything not covered by an allow rule is denied
// outright; the session's own terminal JSON result names exactly
// which Bash calls were denied in a `permission_denials` array, which
// is what this reads rather than inferring approval from the model's
// prose.
//
// A real session also needs its working directory marked as a
// trusted workspace, or non-interactive mode ignores permissions.allow
// entirely and denies everything, allowed or not - discovered
// empirically while building this, not documented anywhere in this
// project before now (see AGENTS.md, and this harness's own README).
// There is no non-interactive flag to grant trust without also
// bypassing permission checks entirely, so this patches the one field
// the CLI's own warning names (`projects[path].hasTrustDialogAccepted`
// in the real, machine-wide `~/.claude.json`) for the duration of the
// check, and restores exactly what was there before in a `finally`
// block - not a blind delete, since a real caller's prior trust,
// history, or other per-project state must come back exactly as it
// was, not be wiped. Every write to that file goes through a
// temp-file-then-rename so a crash mid-write can never leave it
// truncated, and `checkPermissionBoundary` refuses outright to run
// against anything that isn't demonstrably a throwaway path under the
// system temp directory - this function's whole job is patching
// machine-wide state, so it must never be pointed at a real project
// by a caller's mistake. No credential is ever read, copied, or
// printed - authentication rides on whatever the calling machine's
// `claude` is already logged in as.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";

export interface PermissionBoundaryResult {
  available: boolean;
  unavailableReason?: string;
  /** The argument strings each attempted `fabrica <args>` invocation
   * actually received, in the order a fake `fabrica` shim on PATH
   * recorded them running - empty for an attempt that was denied. */
  executedArgs: string[];
  /** The full command strings a real permission_denials entry named. */
  deniedCommands: string[];
}

interface ClaudeConfig {
  projects?: Record<string, unknown>;
}

function configPath(): string {
  return join(homedir(), ".claude.json");
}

function readConfig(): ClaudeConfig {
  return JSON.parse(readFileSync(configPath(), "utf8")) as ClaudeConfig;
}

/** Temp-file-then-rename, never a truncating in-place write - a crash
 * between those two steps for a plain writeFileSync would leave the
 * machine-wide config empty; rename is atomic, so readers only ever
 * see the old file or the new one, never a half-written one. */
function writeConfigAtomic(config: ClaudeConfig): void {
  const target = configPath();
  const tmpPath = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(config, null, 2));
  renameSync(tmpPath, target);
}

/** Marks `targetPath` trusted, returning whatever was there before
 * (possibly undefined) so the caller can put it back exactly. */
function markTrusted(targetPath: string): unknown {
  const config = readConfig();
  config.projects ??= {};
  const prior = config.projects[targetPath];
  const entry = typeof prior === "object" && prior !== null ? { ...(prior as Record<string, unknown>) } : {};
  entry.hasTrustDialogAccepted = true;
  config.projects[targetPath] = entry;
  writeConfigAtomic(config);
  return prior;
}

/** Restores `targetPath`'s entry to `prior` - the project's own real
 * state (trust, history, whatever else lives there) if it had one,
 * or removed entirely if it didn't, never left on whatever this
 * check set it to. */
function restoreTrust(targetPath: string, prior: unknown): void {
  const config = readConfig();
  config.projects ??= {};
  if (prior === undefined) {
    delete config.projects[targetPath];
  } else {
    config.projects[targetPath] = prior;
  }
  writeConfigAtomic(config);
}

/**
 * Runs one real, non-interactive session of this harness inside `cwd`,
 * first installing `settingsJsonPath` (the shipped template under
 * test) at wherever this harness actually reads project settings from
 * - a caller outside this harness's own directory has no business
 * knowing that convention - then instructing the session to attempt
 * each of `attempts` - full `fabrica ...` command strings - in turn
 * via its Bash tool, then reports which ones actually ran.
 *
 * Refuses (throws) unless `rawCwd` resolves under the system temp
 * directory: this function patches machine-wide Claude Code trust
 * state, and doing that against a real project directory - even
 * transiently, even restored afterward - is a mistake this function
 * itself must catch, not something callers can be trusted to avoid.
 */
export async function checkPermissionBoundary(
  rawCwd: string,
  settingsJsonPath: string,
  attempts: string[]
): Promise<PermissionBoundaryResult> {
  // macOS resolves a temp dir through a /var -> /private/var symlink
  // (AGENTS.md's own documented sharp edge); the trust key must match
  // whatever cwd the CLI itself resolves to internally, or the patch
  // below silently lands on a path never actually checked - and the
  // scratch-directory guard below must check the same realpath'd
  // form, or a /var-prefixed path could slip past it too.
  const cwd = realpathSync(rawCwd);
  const scratchRoot = realpathSync(tmpdir());
  if (cwd !== scratchRoot && !cwd.startsWith(scratchRoot + sep)) {
    throw new Error(
      `checkPermissionBoundary refuses to run against ${cwd} - it is not under the system temp directory ` +
        `(${scratchRoot}), and this function patches machine-wide Claude Code trust state that must never ` +
        `be pointed at a real project directory`
    );
  }

  try {
    execFileSync("claude", ["--version"], { stdio: "pipe" });
  } catch {
    return { available: false, unavailableReason: "claude is not installed or not runnable on PATH", executedArgs: [], deniedCommands: [] };
  }

  const settingsDir = join(cwd, ".claude");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(join(settingsDir, "settings.json"), readFileSync(settingsJsonPath));

  const binDir = join(cwd, ".permission-boundary-bin");
  mkdirSync(binDir, { recursive: true });
  const markerPath = join(cwd, ".permission-boundary-marker.log");
  writeFileSync(markerPath, "");
  const shimPath = join(binDir, "fabrica");
  writeFileSync(shimPath, `#!/bin/sh\necho "$*" >> "${markerPath}"\necho ok\n`);
  chmodSync(shimPath, 0o755);

  let priorTrust: unknown;
  try {
    priorTrust = markTrusted(cwd);
  } catch (err) {
    return { available: false, unavailableReason: `could not read or patch the real Claude Code config: ${String(err)}`, executedArgs: [], deniedCommands: [] };
  }

  try {
    const prompt =
      "Use your Bash tool to attempt EACH of the following commands, one at a time, exactly as written, " +
      "in order. Attempt every single one regardless of whether an earlier one succeeded or was denied - " +
      "do not stop early, do not retry a denied command, and do not substitute another way to run it. " +
      "After attempting all of them, stop.\n" +
      attempts.map((a, i) => `${i + 1}. ${a}`).join("\n");

    let raw: string;
    try {
      raw = execFileSync("claude", ["-p", prompt, "--output-format", "json"], {
        cwd,
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
        encoding: "utf8",
        timeout: 180_000,
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (err) {
      return { available: false, unavailableReason: `real session failed to run: ${String(err)}`, executedArgs: [], deniedCommands: [] };
    }

    const parsed = JSON.parse(raw) as {
      result?: string;
      permission_denials?: { tool_name?: string; tool_input?: { command?: string } }[];
    };
    if (typeof parsed.result === "string" && parsed.result.includes("Not logged in")) {
      return { available: false, unavailableReason: "claude is installed but not authenticated", executedArgs: [], deniedCommands: [] };
    }

    const executedArgs = readFileSync(markerPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const deniedCommands = (parsed.permission_denials ?? [])
      .filter((d) => d.tool_name === "Bash")
      .map((d) => d.tool_input?.command ?? "")
      .filter(Boolean);

    return { available: true, executedArgs, deniedCommands };
  } finally {
    restoreTrust(cwd, priorTrust);
  }
}
