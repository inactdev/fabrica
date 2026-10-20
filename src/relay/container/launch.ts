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
// source, so there is nothing new to build or go stale. The files the
// container runs (bootstrap.mjs and what it loads) are plain JavaScript
// importing only `node:` built-ins, so the stock image's `node` runs
// them as-is - nothing from node_modules, no tsx. This works
// identically for a dev checkout and a global npm install: either way,
// `import.meta.url` below resolves to a real directory on disk holding
// this package's own `src/`, and mounting that tree read-only costs
// nothing extra (a bind mount, not a copy).
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
import { appendEvent } from "../../record/index.ts";
import { RelayError } from "../errors.mjs";
import { LISTENING_MARKER, REFUSAL_MARKER } from "./protocol.mjs";
import { CONTAINER_RELAY_PORT } from "./types.ts";
import type { ContainerizedRelayHandle, ContainerizedRelayOptions, RelayContainerConfig } from "./types.ts";

const execFileAsync = promisify(execFile);

/** How often the watcher below reads the relay container's log. A
 * second is far faster than anything downstream needs (the Foreman's own
 * heartbeat, which asks whether the relay is still there, runs every 15)
 * and the log it reads is a handful of lines. */
export const DEFAULT_WATCH_INTERVAL_MS = 1_000;

/** How many `docker logs` reads in a row have to fail before the relay
 * container counts as gone rather than as a daemon hiccup. Two, not one:
 * failing a task is expensive and a single blip must not do it. */
const LOG_FAILURES_BEFORE_GONE = 2;

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

// Removal, not just a stop, and on every path that can throw once
// `docker run` has been attempted: the `--rm` that run carries only
// reaps a container that started and then exited, and a `docker stop`
// returns before the daemon's own reap of it necessarily has. Either
// way the container can still be sitting in `docker ps -a` attached to
// the isolated network, and a network with a container attached to it
// refuses to be removed - so the caller's own teardown failed too,
// leaking both (src/brain/adapters/'s reference adapter calls
// `removeIsolatedNetwork` right after `relay.close()`). Observed on the
// Client's machine after the 2026-10-17 proof runs: a leftover
// `fabrica-relay-<id>` container alongside three undeleted
// `fabrica-worker-<id>` / `fabrica-relay-egress-<id>` networks.
//
// `-f` so whichever state the container got to - created but never
// started, running, exited but not yet reaped - doesn't decide whether
// the cleanup works. A failure here is deliberately swallowed rather
// than reported: the error on its way past this point is the one the
// Client needs to see, and this is a cleanup attempt on something that
// may legitimately already be gone.
async function removeContainer(name: string): Promise<void> {
  await execFileAsync("docker", ["rm", "-f", name]).catch(() => {});
}

async function waitForListening(name: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync("docker", ["logs", name]);
      if (stdout.includes(LISTENING_MARKER)) return;
    } catch {
      // The container may not exist in docker's own bookkeeping yet, an
      // instant after `docker run -d` returns - retried below rather
      // than treated as fatal immediately.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  // Read while the container is still there: its caller removes it the
  // moment this throws, and its own output is the only account of why it
  // never listened, so the tail of it has to ride on the message.
  let logs = "";
  try {
    const { stdout, stderr } = await execFileAsync("docker", ["logs", name]);
    logs = (stderr || stdout).trim();
  } catch {
    // Fall through with no logs to show - the container may be gone
    // already (`--rm` reaps one that started and exited on its own).
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

interface RelayWatcher {
  /** Why the relay stopped serving, once that is established. */
  failure: () => string | undefined;
  /** Drains one last time (so a refusal from the final moments still
   * reaches the record), then stops polling. */
  stop: () => Promise<void>;
}

/** Watches one running relay container from the host, through the only
 * channel that reaches into it - `docker logs`, read one-shot on a
 * timer, exactly as `waitForListening` above already reads it. Two jobs,
 * one call per tick:
 *
 * - Every new `REFUSAL_MARKER` line becomes this task's
 *   `"network-refused"` event, appended HERE, on the host. The relay
 *   used to append it itself from inside the container, which is how a
 *   refusal could kill it (see server.mjs's header); out here, a failed
 *   append is one line on stderr and nothing else - the worker's network
 *   does not depend on it.
 * - A read that fails `LOG_FAILURES_BEFORE_GONE` times running means
 *   docker no longer knows this container: `docker run --rm` reaps one
 *   that exited, taking its name with it (the same fact
 *   `waitForListening`'s own fallback already relies on). That is the
 *   relay being gone, which the caller turns into a failed attempt.
 *
 * Deliberately not `docker logs --follow`: one-shot `docker logs` is the
 * shape this project has already run against a real daemon, and a
 * follower's exit behaviour could not be verified here. The cost is
 * re-reading a tiny log once a second; only the bytes past what was
 * already consumed are parsed, and never a trailing line whose newline
 * has not landed yet. Known limit: a relay container that is stopped but
 * NOT removed still reads as alive, since its log is still there -
 * `--rm` makes that a narrow window. */
function watchRelayContainer(
  name: string,
  recordHome: string,
  taskId: string,
  intervalMs: number
): RelayWatcher {
  let consumedChars = 0;
  let logFailures = 0;
  let failure: string | undefined;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const appendRefusal = (details: Record<string, unknown>): void => {
    try {
      appendEvent(recordHome, { taskId, name: "network-refused", details });
    } catch (err) {
      // Reporting is never allowed to be the thing that breaks: a
      // refusal the record missed costs the Client one line of history,
      // while anything thrown from this timer would be an uncaught
      // exception in the task's own process.
      process.stderr.write(
        `fabrica: could not record a refused request for task ${taskId}: ${errorMessage(err)}\n`
      );
    }
  };

  const consume = (stdout: string): void => {
    // Only up to the last newline: a line still being written must be
    // left for the next read rather than parsed in half and then never
    // seen whole again.
    const complete = stdout.slice(0, stdout.lastIndexOf("\n") + 1);
    if (complete.length <= consumedChars) return;
    const fresh = complete.slice(consumedChars);
    consumedChars = complete.length;
    for (const line of fresh.split("\n")) {
      if (!line.startsWith(`${REFUSAL_MARKER} `)) continue;
      const payload = line.slice(REFUSAL_MARKER.length + 1);
      let details: Record<string, unknown>;
      try {
        details = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        details = { unparsed: payload };
      }
      appendRefusal(details);
    }
  };

  const poll = async (final: boolean): Promise<void> => {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync("docker", ["logs", name]));
    } catch (err) {
      // On the final drain the container is already being stopped, so a
      // failed read here says nothing about its health.
      if (final) return;
      logFailures += 1;
      if (logFailures >= LOG_FAILURES_BEFORE_GONE && failure === undefined) {
        failure = `the task's network relay (container "${name}") is no longer running, so every request from the worker box is refused: ${errorMessage(err)}`;
      }
      return;
    }
    logFailures = 0;
    consume(stdout);
  };

  const schedule = (): void => {
    timer = setTimeout(() => {
      void poll(false).finally(() => {
        if (!stopped) schedule();
      });
    }, intervalMs);
    // Never a reason for this timer alone to hold the process open.
    timer.unref();
  };
  schedule();

  return {
    failure: () => failure,
    stop: async () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await poll(true);
    },
  };
}

/** Starts the relay as a fresh, detached container attached to both
 * `opts.isolatedNetwork` (shared with the worker it serves) and
 * `opts.egressNetwork` (its own route to the real internet) - see this
 * file's header for why it has to be two networks, and two legs, rather
 * than one. Throws `RelayError("listen-failed")` if the container never
 * starts or never confirms it's listening - and on every one of those
 * paths removes the container first, so the caller's own networks can
 * still be torn down afterwards. */
export async function startContainerizedRelay(opts: ContainerizedRelayOptions): Promise<ContainerizedRelayHandle> {
  const image = opts.image ?? RELAY_IMAGE;
  const name = `fabrica-relay-${randomUUID().replace(/-/g, "")}`;
  const repoRoot = realpathSync(REPO_ROOT);

  const config: RelayContainerConfig = {
    port: CONTAINER_RELAY_PORT,
    tunnelAllowlist: opts.tunnelAllowlist,
    gateway: opts.gateway,
    maxRequestBytes: opts.maxRequestBytes,
    maxCallsPerTask: opts.maxCallsPerTask,
  };

  // --env-file, not `-e`: the config carries the real credential
  // (opts.gateway?.credential?.realValue) - neither the key nor the
  // value may appear in `docker run`'s own argv or a host `ps` listing,
  // same reasoning as src/containment/docker-args.ts's own env handling.
  const envFileDir = mkdtempSync(join(realpathSync(tmpdir()), "fabrica-relay-env-"));
  const envFile = join(envFileDir, "env");
  writeFileSync(envFile, `FABRICA_RELAY_CONFIG=${JSON.stringify(config)}\n`);

  // One failure path from the `docker run` attempt onward: whatever goes
  // wrong between here and a handle being returned - the run itself, the
  // container never reporting it's listening, no address on the isolated
  // network, anything unexpected - the container must not be left behind
  // (see `removeContainer` above for what that costs when it is).
  try {
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
        // The checkout, read-only, and nothing else: the record home
        // used to be mounted here too, writable, so the relay could
        // append its own refusal events. It no longer can and no longer
        // needs to (see types.ts's `RelayContainerConfig`), which also
        // means a relay container has no write access to the Client's
        // record at all any more.
        "--mount",
        `type=bind,source=${repoRoot},target=${repoRoot},readonly`,
        "--env-file",
        envFile,
        "--init",
        image,
        "node",
        // Computed from `repoRoot` (post-realpath), not from this file's
        // own `import.meta.url`-derived directory: the two could
        // disagree if the checkout sits behind a symlink (the same macOS
        // /tmp -> /private/tmp class of trap src/line/README.md calls
        // out elsewhere), and `repoRoot` is also what's actually
        // bind-mounted into the container below, so the path handed to
        // `node` must be built from that same resolved root to be
        // guaranteed to exist at the mounted location.
        join(repoRoot, "src", "relay", "container", "bootstrap.mjs"),
      ]);
    } catch (err) {
      // A failed run is not necessarily a container that doesn't exist:
      // `docker run` creates it first and starts it second, so a failure
      // at the start can leave one behind, which the outer catch removes
      // like any other.
      throw new RelayError("listen-failed", `could not start the relay container: ${errorMessage(err)}`);
    }

    await waitForListening(name, opts.listenTimeoutMs);
    const host = await relayAddressOn(name, opts.isolatedNetwork);
    // Started only once the relay is confirmed up and addressable: until
    // then `waitForListening` is the one reading its log, and there is
    // no worker yet for anything to be refused for.
    const watcher = watchRelayContainer(
      name,
      opts.recordHome,
      opts.taskId,
      opts.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS
    );
    return {
      host,
      port: CONTAINER_RELAY_PORT,
      failure: watcher.failure,
      close: async () => {
        // The watcher stops first, and drains once on its way out: a
        // refusal from the relay's last moments still reaches the
        // record, and nothing reports a deliberately stopped container
        // as a failure.
        await watcher.stop();
        await execFileAsync("docker", ["stop", name]).catch(() => {});
        rmSync(envFileDir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    await removeContainer(name);
    rmSync(envFileDir, { recursive: true, force: true });
    throw err;
  }
}
