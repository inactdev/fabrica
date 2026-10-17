// RegisterError: every refusal `fabrica register` produces carries a
// `code` for callers that need to branch on it, and a `message` written
// to be shown to the Client verbatim - naming exactly what is wrong and
// exactly what to do about it, matching src/config's style.
//
// There are a lot of codes here on purpose. This is the one command
// allowed to push, so every step that could go wrong has to be able to
// say which step it was, in its own words - "register failed" would
// leave the Client guessing whether anything reached origin.

export type RegisterErrorCode =
  /** <path> isn't an existing git repository's root. */
  | "not-a-repo"
  /** The repository has no "origin" remote. */
  | "no-origin"
  /** origin exists but could not be read (unreachable, no access). */
  | "origin-unreadable"
  /** gh is missing, or not logged in to origin's own host. */
  | "gh-not-ready"
  /** The Docker daemon is not reachable. */
  | "docker-not-ready"
  /** A fabrica/register branch already exists (locally or on origin). */
  | "branch-exists"
  /** projects.toml already has this project. */
  | "already-registered"
  /** The project name isn't usable as a projects.toml table key. */
  | "bad-name"
  /** The full setup needs --check and --image; one or both is missing. */
  | "missing-check-or-image"
  /** The repo already has .inspector.json on origin, but no check.sh. */
  | "no-check-script"
  /** The check ran in the image and failed. */
  | "check-failed"
  /** The box could not run the check at all - never read as a failure. */
  | "check-not-run"
  /** The temporary worktree could not be created. */
  | "worktree-failed"
  /** Committing the two new files failed. */
  | "commit-failed"
  /** The push to origin failed. */
  | "push-failed"
  /** `gh pr create` failed. */
  | "pull-request-failed"
  /** projects.toml could not be read or written. */
  | "registry-write-failed";

export class RegisterError extends Error {
  readonly code: RegisterErrorCode;

  constructor(code: RegisterErrorCode, message: string) {
    super(message);
    this.name = "RegisterError";
    this.code = code;
  }
}
