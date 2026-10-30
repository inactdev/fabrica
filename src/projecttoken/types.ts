// Which GitHub credential one project's operations go through (issue
// #314, work mode). Internal to src/: whether Fabrica reached GitHub
// with a GitHub App token or with a token the Client put in brain.env
// is its own bookkeeping, not a promise it makes the Client about a
// seam, so none of this belongs in contract/surface.ts. The written-down
// shape of the setting itself (`githubTokenVar`) lives with the rest of
// projects.toml, in src/config.

/** A project's own GitHub token, settled enough to use. */
export interface ProjectToken {
  /** The variable's name in `brain.env`, e.g. `DAYJOB_GITHUB_TOKEN`.
   * This is the half that may be printed - a doctor line names it, and
   * so does every refusal about it. */
  variable: string;
  /** The credential itself. Never printed, never recorded, never put in
   * Fabrica's own process environment: it goes into the environment of
   * one child process, or one request's header, and nowhere else. */
  token: string;
}

/**
 * The three answers "which credential does this project use" can have.
 *
 * There is deliberately no fourth answer meaning "its own token, or the
 * App if that is missing" (the issue's own clarification: "never a
 * fallback"). A project that names a variable holding nothing is
 * refused, not quietly published by some other credential - which is
 * the whole difference between a work-mode project and a mistake.
 */
export type ProjectTokenResolution =
  | { kind: "app" }
  | { kind: "token"; token: ProjectToken }
  | {
      kind: "refused";
      /** Which variable was named and could not be read - always known,
       * since nothing is refused until a name has been found. */
      variable: string;
      /** The whole refusal, written to be printed verbatim to the
       * Client: what is wrong, the line to add, and why no other
       * credential is tried instead. */
      message: string;
      /** The same thing as one `fabrica doctor` fix - the command or the
       * line, with none of the reasoning. */
      fix: string;
    };
