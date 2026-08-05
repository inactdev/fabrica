// The shape of a contained run. LANGUAGE.md has no word yet for "the
// container a Worker's process runs inside" - this module doesn't invent
// one either; it's plumbing `src/brain/adapters/` calls into, not a new
// model in the loop.

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
   * one silently. */
  network: "denied" | "allowed";
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
   * meant to happen outside the Worker). Omit when the command needs
   * nothing outside `workdir`. */
  readOnlyMounts?: string[];
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
}

export interface ContainedRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}
