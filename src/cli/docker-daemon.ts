// "Docker is installed but not running" is the one doctor finding on a
// Mac that `fabrica up` can simply fix instead of reporting (Client
// ruling 2026-10-23): Docker Desktop is a desktop app, it does not come
// up with the machine unless it was told to, and the Client's own answer
// to the FAIL doctor prints has always been to run the one command in
// its fix line - `open -a Docker` - and try again. So `fabrica up` runs
// it, waits up to two minutes for the daemon to answer, says what it is
// waiting on while it waits, and only then lets doctor decide.
//
// macOS only, the same gate and the same reason as
// src/containment/caffeinate.ts: `open` is a macOS binary, Docker
// Desktop is a macOS app, and this project's own tests and CI run on
// Linux - where the whole step is skipped before any process is spawned,
// so nothing here ever runs on a host it cannot work on.
//
// `open -a Docker` is not a command this module chose: it is the fix
// `fabrica doctor`'s own docker check has always printed, and a Docker
// daemon that answers `docker info` is how every other part of this
// project (src/containment, .github/workflows/docker-tests.yml) asks
// whether Docker is there. Nothing here invents a new way to ask or a
// new way to start.

import { execFileSync, spawnSync } from "node:child_process";

/** Two minutes, per the ruling. Docker Desktop's own cold start on a
 * Mac is tens of seconds; this is the ceiling before `fabrica up` stops
 * waiting and lets doctor's own docker FAIL do the talking, not an
 * expected duration. */
export const DOCKER_START_TIMEOUT_MS = 120_000;

/** The label `fabrica doctor`'s own Docker line reports under - which
 * is this module's question, verbatim ("does the daemon answer"), so
 * the string lives here beside it. Exported because the image repair
 * step (src/cli/image-repair.ts) has to find that one line among all of
 * doctor's before it tries to build or pull anything: with no daemon
 * there is nothing a `docker build` could do but fail a second time,
 * and that line already carries the one fix. */
export const DOCKER_LABEL = "docker";
const DOCKER_POLL_INTERVAL_MS = 2_000;
const DOCKER_PROGRESS_INTERVAL_MS = 15_000;

export type DockerDaemonOutcome =
  /** The daemon already answered - nothing was started, nothing printed. */
  | { status: "already-running" }
  /** Not a platform this can start Docker on; the caller's own doctor
   * check reports the daemon being down, as it always did. */
  | { status: "not-macos" }
  /** Started, and the daemon answered within the timeout. */
  | { status: "started" }
  /** `open -a Docker` itself failed - Docker Desktop is not installed
   * here, or could not be launched. `detail` is the command's own
   * output, never this module's guess at what went wrong. */
  | { status: "start-failed"; detail: string }
  /** Launched, but the daemon never answered inside the timeout. */
  | { status: "timed-out" };

/** Whether the Docker daemon answers right now - the same question
 * `fabrica doctor`'s docker check asks, and the one `docker info` is
 * used for across this project. */
export function dockerDaemonUp(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

/** Runs the one command doctor's own fix line names. A missing Docker
 * Desktop is reported by `open` itself ("Unable to find application
 * named 'Docker'"), so this never has to guess whether the app is
 * installed - whatever `open` says is passed straight back up. */
function openDockerApp(): { ok: boolean; detail: string } {
  const result = spawnSync("open", ["-a", "Docker"], { encoding: "utf8", timeout: 30_000 });
  if (result.error) return { ok: false, detail: result.error.message };
  if (result.status !== 0) {
    const said = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim();
    return { ok: false, detail: said || `open -a Docker exited ${result.status}` };
  }
  return { ok: true, detail: "" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface EnsureDockerDaemonOptions {
  /** Defaults to this machine's. A non-darwin platform returns
   * `not-macos` before anything is spawned. */
  platform?: NodeJS.Platform;
  daemonUp?: () => boolean;
  startDockerApp?: () => { ok: boolean; detail: string };
  timeoutMs?: number;
  pollIntervalMs?: number;
  progressIntervalMs?: number;
  /** Progress, for the Client watching the terminal - "what it is
   * waiting on", per the ruling. */
  notify?: (line: string) => void;
  /** Giving up, which is not an error here: the caller's doctor check
   * still gets to report the daemon being down with its own fix. */
  warn?: (line: string) => void;
}

/**
 * Starts Docker Desktop and waits for its daemon, when (and only when)
 * the daemon is down and this is a Mac. Returns what happened and never
 * throws - every outcome other than `started`/`already-running` leaves
 * the caller exactly where it was, with doctor's own docker check still
 * to run and still free to fail.
 */
export async function ensureDockerDaemon(opts: EnsureDockerDaemonOptions = {}): Promise<DockerDaemonOutcome> {
  const platform = opts.platform ?? process.platform;
  if (platform !== "darwin") return { status: "not-macos" };

  const daemonUp = opts.daemonUp ?? dockerDaemonUp;
  if (daemonUp()) return { status: "already-running" };

  const notify = opts.notify ?? (() => {});
  const warn = opts.warn ?? (() => {});
  const timeoutMs = opts.timeoutMs ?? DOCKER_START_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DOCKER_POLL_INTERVAL_MS;
  const progressIntervalMs = opts.progressIntervalMs ?? DOCKER_PROGRESS_INTERVAL_MS;
  const seconds = Math.round(timeoutMs / 1000);

  notify(`Docker is not running - starting it with \`open -a Docker\` and waiting up to ${seconds}s for the daemon.`);
  const started = (opts.startDockerApp ?? openDockerApp)();
  if (!started.ok) {
    warn(`fabrica up: could not start Docker - \`open -a Docker\` said: ${started.detail}`);
    return { status: "start-failed", detail: started.detail };
  }

  const begun = Date.now();
  const deadline = begun + timeoutMs;
  let nextProgress = begun + progressIntervalMs;
  for (;;) {
    if (daemonUp()) {
      notify(`Docker daemon is up after ${Math.round((Date.now() - begun) / 1000)}s.`);
      return { status: "started" };
    }
    if (Date.now() >= deadline) {
      warn(`fabrica up: the Docker daemon still wasn't answering after ${seconds}s.`);
      return { status: "timed-out" };
    }
    if (Date.now() >= nextProgress) {
      notify(`still waiting on the Docker daemon - ${Math.round((Date.now() - begun) / 1000)}s of ${seconds}s.`);
      nextProgress += progressIntervalMs;
    }
    await sleep(pollIntervalMs);
  }
}
