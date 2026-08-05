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

  // Resolved for the same reason workdir is: a read-only mount has to
  // land at its real, physical path (macOS's /var -> /private/var
  // symlink is exactly the trap here - a worktree's .git pointer file
  // records the physical path, so mounting the unresolved one leaves
  // git looking in a place nothing is actually mounted).
  const readOnlyMounts = (opts.readOnlyMounts ?? []).map((path) => {
    try {
      return realpathSync(path);
    } catch (err) {
      throw new ContainmentError(
        "invalid-path",
        `read-only mount "${path}" does not resolve to a real, existing path: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  });

  let homeDir: string | undefined;
  if (opts.homeDir !== undefined) {
    try {
      homeDir = realpathSync(opts.homeDir);
    } catch (err) {
      throw new ContainmentError(
        "invalid-path",
        `homeDir "${opts.homeDir}" does not resolve to a real, existing path: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Docker's long `--mount` form CSV-parses its value, and a comma in a
  // source path can't be escaped - refuse it here with a clear message
  // instead of surfacing docker's own confusing parse error.
  for (const path of [workdir, ...readOnlyMounts, ...(homeDir === undefined ? [] : [homeDir])]) {
    if (path.includes(",")) {
      throw new ContainmentError(
        "invalid-path",
        `"${path}" contains a comma, which docker's --mount flag cannot represent - use a comma-free path`
      );
    }
  }

  const user =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? `${process.getuid()}:${process.getgid()}`
      : undefined;

  const dockerArgs = [
    ...buildDockerArgs({
      workdir,
      network: opts.network,
      env: opts.env,
      image: opts.image,
      user,
      readOnlyMounts,
      memory: opts.memory,
      cpus: opts.cpus,
      pidsLimit: opts.pidsLimit,
      homeDir,
    }),
    command,
    ...args,
  ];

  return new Promise<ContainedRunResult>((resolve, reject) => {
    // The env allowlist's values ride docker's own process environment,
    // matching docker-args.ts's name-only `-e KEY` flags - verified
    // live: docker reads a bare `-e KEY` from its own environment and
    // passes the value into the container.
    const child = spawn("docker", dockerArgs, { env: { ...process.env, ...opts.env } });
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
