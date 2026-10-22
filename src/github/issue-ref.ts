// Which issue a task names, from the three spellings the Client asked
// for (ruling on "make `fabrica do --issue N` fetch that issue"):
//
//   N / #N                                    the project's own origin repo
//   owner/repo#N                              an explicit repository
//   https://github.com/owner/repo/issues/N    the same, as a pasted URL
//
// Parsing only - nothing here reads git, the network, or the record.
// Resolving a bare number against the project's `origin` is
// src/foreman/task-issue.ts's job, because that needs the project; the
// deliberate split keeps this file testable with no repository at all.

import { GitHubError } from "./errors.ts";

/** One issue, fully resolved: the repository it lives in and its number. */
export interface IssueRef {
  owner: string;
  repo: string;
  number: number;
}

/** What a `--issue` value says on its own: always a number, plus the
 * repository when the value named one. A request with no `repo` is
 * resolved against the project's origin remote. */
export interface IssueRequest {
  number: number;
  repo?: { owner: string; repo: string };
}

// GitHub's own naming rules: an owner is letters, digits and dashes; a
// repository name also allows dots and underscores. Kept deliberately
// tight - a value that doesn't match is refused with instructions, never
// guessed at and sent to the API as-is.
const OWNER = "[A-Za-z0-9-]+";
const REPO = "[A-Za-z0-9._-]+";
const NUMBER_ONLY = /^#?(\d+)$/;
const SLUG_HASH = new RegExp(`^(${OWNER})/(${REPO})#(\\d+)$`);
const ISSUE_URL = new RegExp(`^https?://(?:www\\.)?github\\.com/(${OWNER})/(${REPO})/issues/(\\d+)(?:[/?#].*)?$`);

/** How `--issue` is spelled, for every refusal that has to say so. */
export const ISSUE_ARG_FORMS = 'a positive integer, "owner/repo#N", or a GitHub issue URL';

/**
 * The issue a `--issue` value names - a number straight from
 * `Foreman.do`'s ratified `issue` option, or any of the three spellings
 * above as text. Throws `GitHubError("issue-ref-unparsable")` naming the
 * forms it accepts, rather than ever half-reading a value.
 */
export function parseIssueArg(value: number | string): IssueRequest {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1) {
      throw new GitHubError("issue-ref-unparsable", `issue must be ${ISSUE_ARG_FORMS}, got ${value}.`);
    }
    return { number: value };
  }

  const text = value.trim();
  const plain = NUMBER_ONLY.exec(text);
  if (plain) {
    const number = Number(plain[1]);
    if (number < 1) {
      throw new GitHubError("issue-ref-unparsable", `issue must be ${ISSUE_ARG_FORMS}, got "${value}".`);
    }
    return { number };
  }

  const slug = SLUG_HASH.exec(text) ?? ISSUE_URL.exec(text);
  if (slug) {
    const number = Number(slug[3]);
    if (number < 1) {
      throw new GitHubError("issue-ref-unparsable", `issue must be ${ISSUE_ARG_FORMS}, got "${value}".`);
    }
    return { number, repo: { owner: slug[1], repo: slug[2].replace(/\.git$/, "") } };
  }

  throw new GitHubError("issue-ref-unparsable", `issue must be ${ISSUE_ARG_FORMS}, got "${value}".`);
}

/** `owner/repo#N` - what the record stores for an issue outside the
 * project's own repository, and what every message names it by. */
export function formatIssueRef(ref: IssueRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

/** Whether two repositories are the same one. GitHub's own path
 * parameters are case-insensitive (its REST reference says so for both
 * `owner` and `repo`), so `Inactdev/Fabrica` and `inactdev/fabrica` must
 * never read as two different repositories - the difference decides
 * whether a pull request's closing line needs qualifying. */
export function sameRepo(a: { owner: string; repo: string }, b: { owner: string; repo: string }): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
}

/**
 * What the task record's `issue` file says, read back.
 *
 * Two spellings, both written by `src/foreman/task-issue.ts`: a bare
 * number for an issue in the project's own repository (the only form
 * that ever existed before this, so every task registered by an earlier
 * version still reads correctly), and `owner/repo#N` for one explicitly
 * pointed elsewhere. Anything else - a hand-edited file, a future
 * format - answers `undefined` rather than a half-read number: a wrong
 * issue number would put "Closes #<wrong>" on a real pull request.
 */
export function parseStoredIssue(raw: string | null | undefined): IssueRequest | undefined {
  if (raw === null || raw === undefined) return undefined;
  try {
    return parseIssueArg(raw.trim());
  } catch {
    return undefined;
  }
}
