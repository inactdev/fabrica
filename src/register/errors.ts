// RegisterError: every refusal `fabrica register` produces carries a
// `code` for callers that need to branch on it, and a `message` written
// to be shown to the Client verbatim - naming exactly what is wrong and
// exactly what to do about it, matching src/config's style.
//
// There are a lot of codes here on purpose. This is the one command
// allowed to push, so every step that could go wrong has to be able to
// say which step it was, in its own words - "register failed" would
// leave the Client guessing whether anything reached origin.

// Type only, erased at compile time: the proposal's shape belongs to
// propose.ts, and the one refusal that carries it lives here with every
// other refusal rather than off on its own.
import type { InspectorProposal } from "./propose.ts";

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
  /** The repository has no .inspector.json and wasn't told what to write
   * one from, so a proposal was printed instead and nothing happened -
   * see propose.ts. Carried by RegisterProposalError below, the one
   * refusal with data attached. */
  | "proposed"
  /** The repo already has .inspector.json on origin, but no check.sh. */
  | "no-check-script"
  /** `--terms` names something that is not an existing folder. */
  | "terms-unusable"
  /** `--terms` names a folder inside the repository itself, where every
   * worker's own checkout would carry it. */
  | "terms-inside-repo"
  /** `--terms` was given together with a flag that only describes the
   * repository route (`--check`, `--image`, `--timeout`, `--protected`),
   * which this route would have had to ignore. */
  | "terms-with-repository-flags"
  /** `--terms` was given for a repository that already carries
   * .inspector.json on origin's default branch, so its terms are in it
   * and a second set beside it could only disagree. */
  | "terms-not-needed"
  /** A file could not be written into the terms folder. */
  | "terms-write-failed"
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

/**
 * The one refusal that carries data as well as words: a repository with
 * no `.inspector.json` that `register` was not told what to write one
 * from gets a *proposal* instead (issue #114), and a proposal has two
 * streams - the document, which must reach stdout alone so it can be
 * piped into the file, and the per-field reasoning, which must not.
 *
 * It is a refusal and not a result on purpose: nothing was written,
 * nothing was registered, and the exit code is non-zero, so
 * `fabrica register <path> && fabrica do ...` cannot read a proposal as a
 * successful registration. `message` is the stderr block verbatim, so a
 * caller that only knows how to print a RegisterError still says
 * something useful.
 */
export class RegisterProposalError extends RegisterError {
  readonly proposal: InspectorProposal;

  constructor(proposal: InspectorProposal) {
    super("proposed", proposal.notes.join("\n"));
    this.name = "RegisterProposalError";
    this.proposal = proposal;
  }
}
