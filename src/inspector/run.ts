// The local Inspector handoff. Inspector owns independent checks and, once
// inspector#18 lands, publishing a green branch. Fabrica only translates
// its process result into the three verdicts the Foreman records.

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Inspection, Inspector } from "../../contract/surface.ts";

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

async function runInspector(command: string, workdir: string): Promise<Inspection> {
  const result = await new Promise<{
    stdout: OutputTail;
    stderr: OutputTail;
    exitCode: number | null;
    error?: Error;
  }>((resolve) => {
    const child = spawn(command, ["-repo", workdir], { cwd: workdir, stdio: ["ignore", "pipe", "pipe"] });
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
