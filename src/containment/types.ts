// The shape of a contained run. LANGUAGE.md has no word yet for "the
// container a Worker's process runs inside" - this module doesn't invent
// one either; it's plumbing `src/brain/adapters/` calls into, not a new
// model in the loop.

/** One entry of `readOnlyMounts`. A plain string mounts that host path
 * at the same path inside the container. The `{ source, target }` form
 * exists for the one case where the mounted content must differ from
 * what's at that path on the host: shadow-mounting a sanitized copy of
 * a file (the `source`) over a sub-path of an already-mounted directory
 * (the `target`) - verified live that Docker layers a file mount over a
 * directory mount's sub-path correctly. */
export type ReadOnlyMount = string | { source: string; target: string };

export interface RunContainedOptions {
  /** The ProductionLine workdir. Bind-mounted as the container's own
   * `/workdir` (also its working directory) - reads and writes are
   * confined here because nothing else on the host is mounted into the
   * container at all, not because of an allow/deny rule. Resolved via
   * `realpathSync` internally, so a path through a symlink (e.g. macOS's
   * `/tmp` -> `/private/tmp`) still matches correctly. */
  workdir: string;
  /** Network is denied unless deliberately allowed - required, no
   * default, so every call site states the choice rather than inheriting
   * one silently. `{ isolatedNetwork }` (issue #186) is the third
   * option: attach to a named network with no route to the internet
   * (`src/containment/isolated-network.ts`'s `createIsolatedNetwork`)
   * instead of either extreme - the container can still reach the one
   * other thing attached to that same network, a per-task relay
   * container (`src/relay/container/launch.ts`), since containers
   * sharing a network can always reach each other regardless of
   * `--internal`. */
  network: "denied" | "allowed" | { isolatedNetwork: string };
  /** The exact environment variables the contained process receives -
   * "the worker has what it needs," not the Foreman's whole environment.
   * Docker never auto-inherits the host's environment into a container,
   * so this needs no PATH-only base the way a host-process sandbox would
   * - omit it and the container gets only what its own image defines. */
  env?: Record<string, string>;
  /** The Docker image the command runs inside - required, no default,
   * so every call site states what environment its command needs rather
   * than inheriting an arbitrary one. A generic command (`sh`, `cat`)
   * can run in a small stock image; an adapter whose command is a
   * specific tool needs an image that actually has that tool installed. */
  image: string;
  /** Extra host paths made visible read-only, each at its own resolved
   * absolute path rather than remapped under `/workdir`. Exists for the
   * one case that needs it: a ProductionLine workdir is a git worktree,
   * whose `.git` pointer file names the real project's shared `.git` by
   * absolute host path - mounting that path back in, read-only, is what
   * lets git work inside the container at all (`git status`, `git log`,
   * `git diff`), without giving the contained process anywhere to write
   * a commit (verified live: `git commit` fails with "Read-only file
   * system" - a feature, not a limitation, since merges and commits are
   * meant to happen outside the Worker). A `{ source, target }` entry
   * mounts `source`'s content at `target` instead - used to shadow a
   * sanitized copy of the shared .git's `config` over the real one, so
   * a remote URL (which can embed a credential) is never readable from
   * inside the container. Omit when the command needs nothing outside
   * `workdir`. */
  readOnlyMounts?: ReadOnlyMount[];
  /** Memory limit passed to `docker run --memory` (Docker's own syntax,
   * e.g. `"2g"`). Defaults to `DEFAULT_MEMORY` so a runaway process hits
   * a wall instead of the host machine. */
  memory?: string;
  /** CPU limit passed to `docker run --cpus`. Defaults to
   * `DEFAULT_CPUS`, for the same reason `memory` has a default. */
  cpus?: string;
  /** Process/thread count limit passed to `docker run --pids-limit`.
   * Defaults to `DEFAULT_PIDS_LIMIT` - stops a fork bomb outright rather
   * than merely slowing one down. */
  pidsLimit?: number;
  /** A host path mounted read-write as the container's `HOME` (at a
   * fixed internal path, with `HOME` set to match) - persists whatever a
   * tool writes there across multiple calls that share the same
   * `homeDir`, while staying isolated from the real host's home
   * directory and from other tasks' own `homeDir`s. Necessary for any
   * `--user`-run container too: verified live that a UID with no
   * matching `/etc/passwd` entry (the normal case here) otherwise
   * resolves `HOME` to `/`, which is not writable and not a home
   * directory at all. Omit for no persisted home - `HOME` stays `/`. */
  homeDir?: string;
  /** Called with each raw chunk of the contained process's stdout as it
   * arrives, in addition to it being buffered into the eventual
   * `stdout` result - lets a caller that needs to react to output while
   * the process is still running (e.g. an adapter mapping a streamed
   * transcript live, issue #70) do so without waiting for `close`.
   * Omitted, nothing extra happens; `stdout` is unaffected either way. */
  onStdout?: (chunk: string) => void;
  /** Names the container (`docker run --name`), which is what makes it
   * stoppable from outside this call - see `stopSignal`. Must be unique
   * per concurrent run; omitted, docker names it itself and nothing can
   * single it out afterwards. */
  containerName?: string;
  /** Aborting this stops the run: the container is force-removed
   * (`docker rm -f`, the same way `src/relay/container/launch.ts`
   * removes its own) and this call settles with whatever the docker
   * client reported on its way out, rather than waiting for a command
   * that cannot finish.
   *
   * Exists for one case (2026-10-18): a worker box whose task's relay
   * container has died has no network left and will spend minutes
   * failing before it exits by itself. Stopping it keeps the caller's
   * own teardown - the throwaway networks, the relay container - on the
   * ordinary path instead of being abandoned mid-call. Requires
   * `containerName`: without one there is nothing to name to docker, and
   * aborting then does nothing. */
  stopSignal?: AbortSignal;
}

export interface ContainedRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}
