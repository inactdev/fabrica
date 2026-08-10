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
// project before now (see AGENTS.md). There is no non-interactive flag
// to grant trust without also bypassing permission checks entirely, so
// this patches the one field the CLI's own warning names
// (`projects[path].hasTrustDialogAccepted` in the real `~/.claude.json`)
// for the duration of the check, and removes exactly that entry again
// in a `finally` block. No credential is ever read, copied, or printed -
// authentication rides on whatever the calling machine's `claude` is
// already logged in as.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

function setTrust(targetPath: string, trusted: boolean): void {
  const configPath = join(homedir(), ".claude.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { projects?: Record<string, unknown> };
  config.projects ??= {};
  if (trusted) {
    const entry = (config.projects[targetPath] as Record<string, unknown> | undefined) ?? {};
    entry.hasTrustDialogAccepted = true;
    config.projects[targetPath] = entry;
  } else {
    delete config.projects[targetPath];
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/**
 * Runs one real, non-interactive session of this harness inside `cwd`,
 * first installing `settingsJsonPath` (the shipped template under
 * test) at wherever this harness actually reads project settings from
 * - a caller outside this harness's own directory has no business
 * knowing that convention - then instructing the session to attempt
 * each of `attempts` - full `fabrica ...` command strings - in turn
 * via its Bash tool, then reports which ones actually ran.
 */
export async function checkPermissionBoundary(
  rawCwd: string,
  settingsJsonPath: string,
  attempts: string[]
): Promise<PermissionBoundaryResult> {
  try {
    execFileSync("claude", ["--version"], { stdio: "pipe" });
  } catch {
    return { available: false, unavailableReason: "claude is not installed or not runnable on PATH", executedArgs: [], deniedCommands: [] };
  }

  // macOS resolves a temp dir through a /var -> /private/var symlink
  // (AGENTS.md's own documented sharp edge); the trust key must match
  // whatever cwd the CLI itself resolves to internally, or the patch
  // below silently lands on a path never actually checked.
  const cwd = realpathSync(rawCwd);

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

  setTrust(cwd, true);
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
    setTrust(cwd, false);
  }
}
