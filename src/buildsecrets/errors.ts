/**
 * The one thrown refusal this module has (issue #342): a build that
 * needs a credential nothing on this machine can supply.
 *
 * Its own class, rather than a plain `Error`, for one reason: the two
 * places that compose a `docker build` already treat a thrown error as
 * "the project's Dockerfile could not be read", and this is a different
 * fault with a different fix. `src/cli/machine-image.ts` tells the two
 * apart by this class and reports each in its own words.
 *
 * `message` is written to be shown to the Client verbatim, and names
 * variables only - never a value.
 */
export type BuildSecretsErrorCode =
  /** A name `.inspector.json` lists has no value in Fabrica's
   * environment or in `brain.env`. */
  | "missing-build-secret"
  /** A name it lists cannot be an environment variable at all, which
   * Inspector refuses too. */
  | "illegal-build-secret-name";

export class BuildSecretsError extends Error {
  readonly code: BuildSecretsErrorCode;
  /** The variables the message is about, for a caller that wants to
   * report them without re-parsing the sentence. */
  readonly variables: readonly string[];
  /** The Client's own change that clears it. */
  readonly fix: string;

  constructor(code: BuildSecretsErrorCode, message: string, variables: readonly string[], fix: string) {
    super(message);
    this.name = "BuildSecretsError";
    this.code = code;
    this.variables = [...variables];
    this.fix = fix;
  }
}
