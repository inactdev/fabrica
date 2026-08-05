// Runs a command inside a fresh, throwaway Docker container: bind-mounted
// to `opts.workdir` and nowhere else on the host, with network denied
// unless `opts.network` deliberately allows it. A drop-in replacement for
// a plain `child_process.spawn(command, args, { cwd })` - same
// stdout/stderr/exitCode shape - so an adapter can switch to it without
// reshaping how it reads the result.

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { buildDockerArgs } from "./docker-args.ts";
import { ContainmentError } from "./errors.ts";
import type { ContainedRunResult, RunContainedOptions } from "./types.ts";

export async function runContained(
  command: string,
  args: string[],
  opts: RunContainedOptions
): Promise<ContainedRunResult> {
  let workdir: string;
  try {
    workdir = realpathSync(opts.workdir);
  } catch (err) {
    throw new ContainmentError(
      "invalid-path",
      `workdir "${opts.workdir}" does not resolve to a real, existing path: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const user =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? `${process.getuid()}:${process.getgid()}`
      : undefined;

  const dockerArgs = [
    ...buildDockerArgs({ workdir, network: opts.network, env: opts.env, image: opts.image, user }),
    command,
    ...args,
  ];

  return new Promise<ContainedRunResult>((resolve, reject) => {
    const child = spawn("docker", dockerArgs);
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
          `could not run "${command}" contained (docker) in ${workdir}: ${err.code ?? err.message}`
        )
      );
    });
    child.on("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
  });
}
