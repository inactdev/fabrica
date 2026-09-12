// The local Inspector handoff. Inspector owns independent checks and, once
// inspector#18 lands, publishing a green branch. Fabrica only translates
// its process result into the three verdicts the Foreman records.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Inspection, Inspector } from "../../contract/surface.ts";

export const INSPECTOR_CONFIG = ".inspector.json";
export const MAX_INSPECTION_REPORT_BYTES = 16 * 1024;

/** True only when this revision of the ProductionLine can be inspected. */
export function inspectorIsConfigured(workdir: string): boolean {
  return existsSync(join(workdir, INSPECTOR_CONFIG));
}

/** The production adapter for the Inspector command installed on PATH. */
export function defaultInspector(): Inspector {
  return inspectorAdapter();
}

/** Allows tests to run a throwaway command without invoking real Inspector. */
export function inspectorAdapter(command: string = "inspector"): Inspector {
  return {
    async inspect({ workdir }) {
      return runInspector(command, workdir);
    },
  };
}

async function runInspector(command: string, workdir: string): Promise<Inspection> {
  const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null; error?: Error }>((resolve) => {
    const child = spawn(command, ["-repo", workdir], { cwd: workdir, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
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

  const report = reportForRecord(
    [result.stdout.trim(), result.stderr.trim()].filter((part) => part.length > 0).join("\n") ||
      `Inspector exited ${result.exitCode ?? "after a signal"}.`
  );
  if (result.exitCode === 0) return { verdict: "green", report };
  if (result.exitCode === 1) return { verdict: "red", report };
  return { verdict: "refused", report };
}

/** Bounds stored output while keeping Inspector's final diagnosis. */
export function reportForRecord(report: string): string {
  const total = Buffer.byteLength(report, "utf8");
  if (total <= MAX_INSPECTION_REPORT_BYTES) return report;

  // Leave room for the marker itself, so the stored report is actually
  // bounded by MAX_INSPECTION_REPORT_BYTES rather than merely its tail.
  const marker = (kept: number) => `[truncated, showing last ${kept} of ${total} bytes]\n`;
  const maxTail = MAX_INSPECTION_REPORT_BYTES - Buffer.byteLength(marker(MAX_INSPECTION_REPORT_BYTES), "utf8");
  const tail = Buffer.from(report, "utf8")
    .subarray(total - maxTail)
    .toString("utf8")
    .replace(/^\uFFFD+/, "");
  const kept = Buffer.byteLength(tail, "utf8");
  return `${marker(kept)}${tail}`;
}
