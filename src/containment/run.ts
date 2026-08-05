// Runs a command inside a per-call Seatbelt sandbox (macOS's `sandbox-exec`),
// confined to `opts.workdir` for reads and writes, with network denied
// unless `opts.network` deliberately allows it. A drop-in replacement for
// a plain `child_process.spawn(command, args, { cwd })` - same
// stdout/stderr/exitCode shape - so an adapter can switch to it without
// reshaping how it reads the result.

import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainmentError } from "./errors.ts";
import { buildProfile } from "./profile.ts";
import type { ContainedRunResult, RunContainedOptions } from "./types.ts";

export async function runContained(
  command: string,
  args: string[],
  opts: RunContainedOptions
): Promise<ContainedRunResult> {
  if (process.platform !== "darwin") {
    throw new ContainmentError(
      "unsupported-platform",
      `runContained only implements macOS's sandbox-exec (Seatbelt); this process is running on "${process.platform}".`
    );
  }

  const workdir = realpathSync(opts.workdir);
  const homeDir = realpathSync(opts.homeDir);
  const profile = buildProfile({ workdir, homeDir, network: opts.network });

  // The profile is written to its own throwaway temp dir per call, not
  // reused across calls or tasks - two Workers running at once never
  // share or race on the same profile file.
  const profileDir = mkdtempSync(join(realpathSync(tmpdir()), "fabrica-containment-"));
  const profilePath = join(profileDir, "profile.sb");
  writeFileSync(profilePath, profile);

  try {
    return await new Promise<ContainedRunResult>((resolve, reject) => {
      const child = spawn("sandbox-exec", ["-f", profilePath, command, ...args], {
        cwd: workdir,
        env: { PATH: process.env.PATH ?? "", ...(opts.env ?? {}) },
      });
      child.stdin.end();
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.on("error", (err: NodeJS.ErrnoException) => {
        reject(
          new ContainmentError(
            "spawn-failed",
            `could not run "${command}" contained (sandbox-exec) in ${workdir}: ${err.code ?? err.message}`
          )
        );
      });
      child.on("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
    });
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
}
