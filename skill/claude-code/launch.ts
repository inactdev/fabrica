// The harness-specific half of `fabrica up`
// (src/cli/up-command.ts finds this by scanning skill/ at runtime and
// dynamically importing whichever subfolder has a launch.ts, rather
// than a literal import specifier - which would name a harness inside
// src/ and trip rule 8's brain-word scan exactly like a comment would.
// See verify.ts's header for the full reasoning; this is the same
// pattern for a second per-harness capability).
//
// Launches a real, interactive, non-bypassed session in `cwd` with the
// handbook text appended to its system prompt and this harness's own
// settings file loaded through its own command-line flags - both read
// from `claude --help`'s own documented `--append-system-prompt
// <prompt>` and `--settings <file-or-json>` entries, never guessed.
// Nothing is written into `cwd`: both are passed as flags, not files
// dropped into a `.claude` folder there.

import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";

export interface LaunchOptions {
  cwd: string;
  settingsPath: string;
  appendSystemPrompt: string;
}

export interface LaunchResult {
  exitCode: number;
}

/** Blocks until the interactive session exits, inheriting this
 * process's stdio so the Client's terminal is the session itself. */
export function launch(opts: LaunchOptions): LaunchResult {
  const result = spawnSync("claude", ["--settings", opts.settingsPath, "--append-system-prompt", opts.appendSystemPrompt], {
    cwd: opts.cwd,
    stdio: "inherit",
  });
  return { exitCode: result.status ?? 0 };
}

/** True when the harness binary can be found and run at all - a
 * distinct failure from anything about the session itself. */
export function harnessAvailable(): boolean {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}
