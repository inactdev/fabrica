// Builds the argument list `runContained` hands to `docker run`. Every
// flag here was chosen by running it against the real Docker daemon on
// the real machine, not guessed - see README.md for what was verified.

import type { ReadOnlyMount } from "./types.ts";

// Conservative caps a runaway process can't talk its way past - chosen
// to comfortably run a real coding-agent workload (installs, builds,
// test runs) while still hitting a wall well short of the host itself.
export const DEFAULT_MEMORY = "2g";
export const DEFAULT_CPUS = "2";
export const DEFAULT_PIDS_LIMIT = 512;

// Where a mounted homeDir lands inside the container. Fixed and
// internal - callers name a host path, never this one, the same way
// `/workdir` itself is never a caller's concern.
const CONTAINER_HOME = "/home/worker";
const CONTAINER_WORKDIR = "/workdir";

export function buildDockerArgs(opts: {
  workdir: string;
  network: "denied" | "allowed" | { isolatedNetwork: string };
  envFile?: string;
  image: string;
  user?: string;
  readOnlyMounts?: ReadOnlyMount[];
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  homeDir?: string;
  containerName?: string;
}): string[] {
  // The long `--mount` form, not `-v`: its key=value fields don't split
  // on a ':' appearing in the workdir path the way the short form does.
  const args = [
    "run",
    "--rm",
    "--mount",
    `type=bind,source=${opts.workdir},target=${CONTAINER_WORKDIR}`,
    "-w",
    CONTAINER_WORKDIR,
  ];

  // A name only when the caller asked for one - it is what lets this
  // container be force-removed from outside the call that started it
  // (see `stopSignal` in types.ts). Unnamed otherwise, exactly as
  // before, so nothing that never needs stopping gains a name docker
  // would have to keep unique.
  if (opts.containerName !== undefined) args.push("--name", opts.containerName);

  // Each extra path is mounted read-only at its own resolved path, not
  // remapped - a git worktree's .git pointer file names the project's
  // real .git by absolute host path, so that path has to exist at the
  // same location inside the container for git to find it at all. A
  // { source, target } entry mounts different content at target - the
  // shadow-a-sanitized-file-over-a-mounted-directory's-sub-path case,
  // which Docker layers correctly (verified live).
  for (const mount of opts.readOnlyMounts ?? []) {
    const source = typeof mount === "string" ? mount : mount.source;
    const target = typeof mount === "string" ? mount : mount.target;
    args.push("--mount", `type=bind,source=${source},target=${target},readonly`);
  }

  // Run as the invoking host user, not root: on native Linux, files a
  // root container writes into the bind mount come out root-owned on
  // the host, breaking host-side git and teardown - see README.md.
  if (opts.user !== undefined) args.push("--user", opts.user);

  // Denied is the absence of network access, not a rule fenced around
  // it - Docker's own `--network none` gives the container no network
  // interface at all (verified: DNS resolution itself fails under it).
  // The isolated-network form (issue #186) is the middle ground: a
  // named network with no route to the internet (created by
  // isolated-network.ts's createIsolatedNetwork, "--internal") whose
  // only other member is a relay container (src/relay/container/
  // launch.ts) - the one thing on this network the worker can still
  // reach, since containers on the same network can always reach each
  // other regardless of `--internal`. Nothing here binds to this
  // network's own gateway address any more - that address turned out to
  // belong to the Docker Desktop VM on Mac/Windows, not to the host
  // process, so a relay bound there was unreachable; see isolated-
  // network.ts's own header for the proven fact and src/relay/
  // container/launch.ts for the fix.
  if (opts.network === "denied") args.push("--network", "none");
  else if (typeof opts.network === "object") args.push("--network", opts.network.isolatedNetwork);

  // Docker never auto-inherits the host's environment into a container
  // (verified), so nothing needs filtering here - only what's in the
  // file reaches the container, exactly "the worker has what it needs."
  // `--env-file`, not `-e KEY=value` or even name-only `-e KEY`: neither
  // the keys nor the values ever appear in host `ps` listings of the
  // docker command line (verified: `ps` shows only the file path), and
  // - unlike merging opts.env into the spawned docker client's own
  // process environment - a value can never collide with a variable the
  // docker CLI itself consumes (DOCKER_HOST, DOCKER_CONFIG, PATH, ...).
  // runContained writes this file fresh per call and removes it after.
  if (opts.envFile !== undefined) args.push("--env-file", opts.envFile);

  // Trusting /workdir for git is safe: the container is the trust boundary, and its git config is sanitized and read-only.
  args.push("-e", "GIT_CONFIG_COUNT=1", "-e", "GIT_CONFIG_KEY_0=safe.directory", "-e", `GIT_CONFIG_VALUE_0=${CONTAINER_WORKDIR}`);

  // Persists whatever a tool writes under $HOME (e.g. session state for
  // a warm --resume) across calls that share this same homeDir, without
  // which a --user container's HOME resolves to "/" (verified live: no
  // /etc/passwd entry for an arbitrary host UID) - added after the env
  // loop so this HOME always wins if a caller's own env also set one.
  if (opts.homeDir !== undefined) {
    args.push("--mount", `type=bind,source=${opts.homeDir},target=${CONTAINER_HOME}`);
    args.push("-e", `HOME=${CONTAINER_HOME}`);
  }

  // Resource caps, always on - verified live: --memory sets the real
  // cgroup limit (read back from /sys/fs/cgroup), and --pids-limit
  // genuinely blocks forking past it ("can't fork: Resource temporarily
  // unavailable"), not just a documented ceiling nobody enforces.
  args.push("--memory", opts.memory ?? DEFAULT_MEMORY);
  args.push("--cpus", opts.cpus ?? DEFAULT_CPUS);
  args.push("--pids-limit", String(opts.pidsLimit ?? DEFAULT_PIDS_LIMIT));

  // A tiny process 1 that collects finished processes. Without it,
  // process 1 is the command itself (npm, the CLI), which leaves every
  // orphaned child it did not start as a zombie counted against
  // --pids-limit - verified live: a full test suite hit the limit and hung.
  args.push("--init");

  args.push(opts.image);
  return args;
}
