// The shape of a contained run. LANGUAGE.md has no word yet for "the
// sandbox a Worker's process runs inside" - this module doesn't invent
// one either; it's plumbing `src/brain/adapters/` calls into, not a new
// model in the loop.

export interface RunContainedOptions {
  /** The ProductionLine workdir. Read and write access is confined to
   * this directory - nothing else on disk can be written to, and nothing
   * under `homeDir` outside this directory can be read. Resolved via
   * `realpathSync` internally, so a path through a symlink (e.g. macOS's
   * `/tmp` -> `/private/tmp`) still matches correctly. */
  workdir: string;
  /** The directory excluded from the otherwise-broad read allowance -
   * concretely, the real home directory (`os.homedir()`), passed in
   * rather than read internally so tests can point it at a throwaway
   * fixture instead of the machine's real home. `workdir` is re-opened as
   * an explicit exception even when it lives inside this directory (the
   * common case: Fabrica's own `recordHome` defaults to `~/.fabrica`). */
  homeDir: string;
  /** Network is denied unless deliberately allowed - required, no
   * default, so every call site states the choice rather than inheriting
   * one silently. */
  network: "denied" | "allowed";
}

export interface ContainedRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}
