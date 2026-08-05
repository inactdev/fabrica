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
}

export interface ContainedRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}
