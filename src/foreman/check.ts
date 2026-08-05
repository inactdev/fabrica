// Runs a ProductionLine's check command and reports whether it was green
// (CONTRACT rule 2: "done" means proven — no third option, no path around
// the gate). The command itself comes from resolve-check.ts: a registered
// project's configured `check`, or the v1 default convention.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ForemanError } from "./errors.ts";
import type { GateResult } from "../../contract/surface.ts";

export const DEFAULT_CHECK_COMMAND = "./check.sh";

/** Throws ForemanError("missing-check") when the default convention would
 * apply but there's no check.sh to run — rule 2 allows no path around the
 * gate, so `do()` refuses before any worker runs, when there is nothing
 * yet to verify with, rather than after. A configured check command (from
 * projects.toml) is trusted as-is; it need not be a file at all. */
export function requireCheckCommand(workdir: string, check: string): void {
  if (check === DEFAULT_CHECK_COMMAND && !existsSync(join(workdir, "check.sh"))) {
    throw new ForemanError(
      "missing-check",
      `${workdir} has no check.sh. No check command, no verified work, no ` +
        `exceptions. Add an executable check.sh at the project's root, or ` +
        `register this project in projects.toml with a check command.`
    );
  }
}

/** Runs `check` in `workdir` via a shell (config's `check` can be any
 * shell command, e.g. "npm test && npm run lint" — not just a single
 * file) and reports the result. Never throws on a non-zero exit; that is
 * a legitimate red, not a failure of this function. */
export function runCheck(workdir: string, check: string): GateResult {
  try {
    const output = execSync(check, {
      cwd: workdir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // A verbose-but-passing check must never be misread as red just
      // because its output outgrew node's default 1MB buffer.
      maxBuffer: 64 * 1024 * 1024,
    });
    return { green: true, output: `${check} -> exit 0${output ? `\n${output}` : ""}` };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    const code = e.status ?? "unknown";
    const combined = [e.stdout, e.stderr].filter((s) => s && s.length > 0).join("\n");
    return { green: false, output: `${check} -> exit ${code}${combined ? `\n${combined}` : ""}` };
  }
}
