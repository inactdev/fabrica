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
  /** Passes `claude`'s own `-c`/`--continue` (verified against `claude
   * --help`: "Continue the most recent conversation in the current
   * directory") so `fabrica up --continue` resumes the session that was
   * running in this folder rather than starting a new one. */
  continueSession?: boolean;
  /** The environment to run the session in (issue #359). `fabrica up`
   * passes its own plus the sentinel that marks this process tree as the
   * assistant's, which is what lets a `fabrica verdict`/`fabrica answer`
   * the assistant runs from inside here be recorded as run on the
   * Client's instruction rather than typed by him. Omitted, this
   * process's own environment is inherited, exactly as before. */
  env?: NodeJS.ProcessEnv;
}

export interface LaunchResult {
  exitCode: number;
}

/** Blocks until the interactive session exits, inheriting this
 * process's stdio so the Client's terminal is the session itself. */
export function launch(opts: LaunchOptions): LaunchResult {
  const args = ["--settings", opts.settingsPath, "--append-system-prompt", opts.appendSystemPrompt];
  if (opts.continueSession) args.push("--continue");
  const result = spawnSync("claude", args, {
    cwd: opts.cwd,
    stdio: "inherit",
    ...(opts.env ? { env: opts.env } : {}),
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
