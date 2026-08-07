// The harness-specific half of `fabrica verify-hook`
// (src/cli/verify-hook-command.ts finds this by scanning skill/ at
// runtime and dynamically importing whichever subfolder has a verify.ts,
// rather than a literal import specifier - which would name a harness
// inside src/ and trip rule 8's brain-word scan exactly like a comment
// would). Actually spawns a real, non-bypassed session here and asks it
// to create a throwaway file, so the CLI command can observe whether the
// session's own installed config denies it.
//
// This is the one place allowed to name the harness at all - confined to
// this per-harness folder like everything else specific to it, the same
// reason src/brain/adapters/ is the one src/ directory the rule 8
// brain-word scan skips (contract/rule8.no-favorite-brain.test.ts scans
// the rest of src/ for a harness's name, and skill/ is outside src/
// entirely).

import { execFileSync } from "node:child_process";

export function attemptRealEdit(cwd: string, targetFileName: string): void {
  try {
    execFileSync(
      "claude",
      [
        "-p",
        `Create a new file named "${targetFileName}" in the current directory containing the single line ` +
          `"verify". Just try it, don't ask questions or explain.`,
        "--permission-mode",
        "default",
      ],
      { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }
    );
  } catch {
    // A non-zero exit or timeout from the chat agent itself doesn't decide
    // the verdict on its own - the caller decides pass or fail from
    // whether the file exists and whether the attempt was logged, both
    // checked independently of how this call itself exited.
  }
}

/** True when the harness binary can be found and run at all - a
 * distinct failure from "the edit wasn't denied": if this is false, the
 * command never even got to test anything. */
export function harnessAvailable(): boolean {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}
