// Runs the relay itself as a Docker container, not a host process -
// necessary because of a fact proven on the Client's own Mac
// (2026-10-17): a container on a Docker `--internal` network cannot
// reach the host machine at all, neither via that network's own gateway
// address (owned by the Docker Desktop VM, not the Mac) nor via
// `host.docker.internal` (`--internal` strips the route Docker Desktop
// otherwise sets up for that name). A relay a worker's container can
// actually reach therefore has to be something containers on that same
// network *can* reach - another container on it - with its own,
// separate route out for real traffic. See src/relay/README.md's "Why
// the relay is the container with two networks" for the full comparison
// against the rejected alternative (a second, non-internal network on
// the *worker* instead).
//
// Rather than build and maintain a bespoke relay image, this bind-
// mounts the running Fabrica checkout itself (read-only) into a stock,
// digest-pinned Node image and runs the relay straight from its own
// TypeScript source via tsx - exactly how `fabrica` already runs itself
// (src/cli/bin.mjs), so there is nothing new to build or go stale. This
// works identically for a dev checkout and a global npm install: either
// way, `import.meta.url` below resolves to a real directory on disk
// holding this package's own `src/` and `node_modules/` (tsx is already
// a runtime dependency - see AGENTS.md's "Installable from zero"), and
// mounting that tree read-only costs nothing extra (a bind mount, not a
// copy).
//
// The host side of this (this file) never talks to the relay container
// directly over the network either - same Docker-Desktop boundary as
// above, just the other direction. Readiness and the relay's own
// address are both read through the Docker CLI/API (`docker logs`,
// `docker inspect`), which is control-plane, not network traffic, and
// works regardless of which side of the VM boundary anything is on.

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RelayError } from "../errors.ts";
import { CONTAINER_RELAY_PORT } from "./types.ts";
import type { ContainerizedRelayHandle, ContainerizedRelayOptions, RelayContainerConfig } from "./types.ts";

const execFileAsync = promisify(execFile);

// The exact digest src/brain/adapters/docker/Dockerfile's own `FROM`
// line already pins (Node 24.18.0 on Alpine 3.24.1) - reused rather than
// looked up fresh, so there is only one place in this repo that claims a
// Node base image digest is current. relay-image-digest.test.ts proves
// the two stay in sync.
export const RELAY_IMAGE = "node@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd";

// This file lives at <repoRoot>/src/relay/container/launch.ts - three
// levels up from its own directory is <repoRoot>.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function waitForListening(name: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync("docker", ["logs", name]);
      if (stdout.includes("FABRICA-RELAY-LISTENING")) return;
    } catch {
      // The container may not exist in docker's own bookkeeping yet, an
      // instant after `docker run -d` returns - retried below rather
      // than treated as fatal immediately.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  let logs = "";
  try {
    const { stdout, stderr } = await execFileAsync("docker", ["logs", name]);
    logs = (stderr || stdout).trim();
  } catch {
    // Fall through with no logs to show - the container may be gone.
  }
  throw new RelayError(
    "listen-failed",
    `relay container "${name}" never reported it was listening within ${timeoutMs}ms${logs ? `: ${logs.slice(-500)}` : ""}`
  );
}

async function relayAddressOn(name: string, network: string): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("docker", [
      "inspect",
      name,
      "--format",
      `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
    ]));
  } catch (err) {
    throw new RelayError("listen-failed", `could not read relay container "${name}"'s address on "${network}": ${errorMessage(err)}`);
  }
  const ip = stdout.trim();
  if (!ip) {
    throw new RelayError("listen-failed", `relay container "${name}" has no address on isolated network "${network}"`);
  }
  return ip;
}

/** Starts the relay as a fresh, detached container attached to both
 * `opts.isolatedNetwork` (shared with the worker it serves) and
 * `opts.egressNetwork` (its own route to the real internet) - see this
 * file's header for why it has to be two networks, and two legs, rather
 * than one. Throws `RelayError("listen-failed")` if the container never
 * starts or never confirms it's listening. */
export async function startContainerizedRelay(opts: ContainerizedRelayOptions): Promise<ContainerizedRelayHandle> {
  const image = opts.image ?? RELAY_IMAGE;
  const name = `fabrica-relay-${randomUUID().replace(/-/g, "")}`;
  const repoRoot = realpathSync(REPO_ROOT);
  const recordHome = realpathSync(opts.recordHome);

  const config: RelayContainerConfig = {
    recordHome,
    taskId: opts.taskId,
    tunnelAllowlist: opts.tunnelAllowlist,
    gateway: opts.gateway,
  };

  // --env-file, not `-e`: the config carries the real credential
  // (opts.gateway?.credential?.realValue) - neither the key nor the
  // value may appear in `docker run`'s own argv or a host `ps` listing,
  // same reasoning as src/containment/docker-args.ts's own env handling.
  const envFileDir = mkdtempSync(join(realpathSync(tmpdir()), "fabrica-relay-env-"));
  const envFile = join(envFileDir, "env");
  writeFileSync(envFile, `FABRICA_RELAY_CONFIG=${JSON.stringify(config)}\n`);

  try {
    await execFileAsync("docker", [
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "--network",
      opts.isolatedNetwork,
      "--network",
      opts.egressNetwork,
      "--mount",
      `type=bind,source=${repoRoot},target=${repoRoot},readonly`,
      "--mount",
      `type=bind,source=${recordHome},target=${recordHome}`,
      "--env-file",
      envFile,
      "--init",
      image,
      "node",
      // Computed from `repoRoot` (post-realpath), not from this file's
      // own `import.meta.url`-derived directory: the two could disagree
      // if the checkout sits behind a symlink (the same macOS /tmp ->
      // /private/tmp class of trap src/line/README.md calls out
      // elsewhere), and `repoRoot` is also what's actually bind-mounted
      // into the container below, so the path handed to `node` must be
      // built from that same resolved root to be guaranteed to exist at
      // the mounted location.
      join(repoRoot, "src", "relay", "container", "bootstrap.mjs"),
    ]);
  } catch (err) {
    rmSync(envFileDir, { recursive: true, force: true });
    throw new RelayError("listen-failed", `could not start the relay container: ${errorMessage(err)}`);
  }

  try {
    await waitForListening(name);
    const host = await relayAddressOn(name, opts.isolatedNetwork);
    return {
      host,
      port: CONTAINER_RELAY_PORT,
      close: async () => {
        await execFileAsync("docker", ["stop", name]).catch(() => {});
        rmSync(envFileDir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    await execFileAsync("docker", ["stop", name]).catch(() => {});
    rmSync(envFileDir, { recursive: true, force: true });
    throw err;
  }
}
