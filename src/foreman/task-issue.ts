// The issue a task names, carried into every brief (Client ruling on
// "make `fabrica do ... --issue N` fetch that issue's title and body"):
// a task worded "do issue #N as written" must never have to ask what #N
// says.
//
// Four decisions the Client settled, all of them visible here:
//
//   1. A bare `--issue N` resolves against the project's `origin`
//      remote - the same remote every task branch is already cut from
//      (src/line/cut.ts) - by reading owner/repo out of its URL.
//      `owner/repo#N` and a pasted issue URL are explicit overrides.
//   2. Fetched once, at registration, and frozen for the life of the
//      task: the record is append-only and a task answers the request
//      as it was made. An issue edited afterwards is a new task - which
//      is why every later round reads `issue.md` back off the record
//      (`taskIssueText`) instead of asking GitHub again.
//   3. Verbatim and in full in every round's brief, the clarifying step
//      included - never truncated, never summarized. Past a hard
//      ceiling (src/github's `MAX_ISSUE_BYTES`) the task is refused
//      instead, naming the size.
//   4. A fetch that fails refuses the task before any ProductionLine is
//      cut, naming the cause.
//
// Nothing here spawns a process: the GitHub call is a plain HTTPS
// request (src/github/fetch-issue.ts) and the only git this needs is
// `origin`'s URL, asked through src/register, so
// `no-host-check.test.ts`'s rule that src/foreman spawns nothing but git
// holds by construction.

import { readTaskFile, writeTaskFile } from "../record/index.ts";
import { formatIssueRef, parseIssueArg, parseStoredIssue, sameRepo } from "../github/index.ts";
import { GitHubError, githubIssueSource } from "../github/index.ts";
import type { FetchedIssue, IssueRef, IssueRequest } from "../github/index.ts";
import { hostFromOriginUrl, originUrl, ownerRepoFromOriginUrl } from "../register/index.ts";
import { resolveGithubToken } from "../inspector/index.ts";
import { ForemanError } from "./errors.ts";
import type { ClosesIssue } from "./pr-body.ts";

/** The one host this reads issues from. A GitHub Enterprise remote has
 * its own API root and its own token, neither of which Inspector's
 * publishing token is - so such a project is told to name the issue
 * explicitly rather than quietly asked about on api.github.com. */
const GITHUB_HOST = "github.com";

/**
 * Everything the issue step reads from outside Fabrica: which GitHub
 * repository a project's pull requests are opened in, and one issue's
 * own words.
 *
 * One object rather than two options, because replacing half of it is
 * no use: a fake issue still can't be fetched for a bare `--issue N` if
 * resolving that number against the project's `origin` demands a real
 * github.com remote - which no test fixture has (every fixture's origin
 * is a throwaway local mirror). A test hands over both halves; the real
 * pair is `defaultIssueReader` below.
 */
export interface IssueReader {
  /** The `owner/repo` a project's pull requests are opened in, read from
   * its `origin` remote - or null when origin is missing, unparseable,
   * or not on github.com, where there is no GitHub repository to resolve
   * a bare issue number against. */
  projectRepo(project: string): { owner: string; repo: string } | null;
  /** One issue's title and body. */
  issue(ref: IssueRef): Promise<FetchedIssue>;
}

/** The heading the issue section carries into a brief. Also the marker
 * `withIssueText` keys on, so a brief that already carries the issue is
 * never given it twice. */
export const ISSUE_BRIEF_HEADER =
  "The GitHub issue this task names, fetched when the task was registered - its own words, in full:";

/** What a `--issue` value says on its own, as a `ForemanError` when it
 * says nothing readable. Separate from `resolveIssueRef` below so the
 * shape of the value can be refused before a task is registered at all,
 * while resolving which repository it means waits until the project has
 * been proven to be a git repository. */
export function parseIssueArgOrRefuse(issueArg: number | string): IssueRequest {
  try {
    return parseIssueArg(issueArg);
  } catch (err) {
    throw new ForemanError("invalid-issue", `fabrica do: ${messageOf(err)}`);
  }
}

/**
 * Which issue a `--issue` value means for this project, with no network
 * involved. Throws `ForemanError("invalid-issue")` for a value that
 * names nothing readable, and `ForemanError("issue-unavailable")` when a
 * bare number has no GitHub repository to resolve against.
 */
export function resolveIssueRef(project: string, issueArg: number | string, reader: IssueReader): IssueRef {
  const request = parseIssueArgOrRefuse(issueArg);
  if (request.repo) return { ...request.repo, number: request.number };

  const repo = reader.projectRepo(project);
  if (repo === null) {
    throw new ForemanError(
      "issue-unavailable",
      `fabrica do: --issue ${request.number} is read from github.com, and ${project}'s "origin" remote ` +
        `${describeOrigin(project)}. Name the issue as owner/repo#N, or paste its URL.`
    );
  }
  return { ...repo, number: request.number };
}

/** Why a project has no GitHub repository to resolve a bare issue
 * number against - the half of the refusal above that names the actual
 * state of the project, rather than only what to do about it. */
function describeOrigin(project: string): string {
  const url = originUrl(project);
  if (url === null) return "is missing";
  return `is ${url}`;
}

/** The real pair: origin's own `owner/repo` when that remote is on
 * github.com, and one documented GET with the GitHub token Inspector
 * publishes with (`GITHUB_TOKEN`, else `gh auth token` - resolved in
 * src/inspector so the two sides can never disagree about which token
 * Fabrica has). The token is never logged, printed, or recorded. */
export function defaultIssueReader(env: NodeJS.ProcessEnv = process.env): IssueReader {
  return {
    projectRepo(project) {
      const url = originUrl(project);
      if (url === null || hostFromOriginUrl(url) !== GITHUB_HOST) return null;
      return ownerRepoFromOriginUrl(url);
    },
    async issue(ref) {
      let token: string;
      try {
        token = resolveGithubToken(env).token;
      } catch (err) {
        throw new GitHubError(
          "issue-fetch-failed",
          `Reading issue ${formatIssueRef(ref)} needs the GitHub token Inspector publishes with. ${messageOf(err)}`
        );
      }
      return githubIssueSource({ token })(ref);
    },
  };
}

/**
 * Registration's issue step: resolve the value, read the issue once, and
 * write both record files - `issue` (what a pull request closes) and
 * `issue.md` (the issue's own words, frozen). Returns the text every
 * round of this task will put in its worker's brief.
 *
 * Every failure is a `ForemanError` whose message names the cause, and
 * is raised before anything is cut: `src/foreman/ask.ts` calls this
 * before `brain.ask()`, so a task whose issue could not be read never
 * starts, never spends, and says why.
 */
export async function fetchTaskIssue(
  recordHome: string,
  taskId: string,
  project: string,
  issueArg: number | string,
  reader: IssueReader = defaultIssueReader()
): Promise<string> {
  const ref = resolveIssueRef(project, issueArg, reader);

  let issue: FetchedIssue;
  try {
    issue = await reader.issue(ref);
  } catch (err) {
    // Every message from src/github is already one complete, actionable
    // sentence naming the cause - prefixed with the command, never
    // restated or softened here.
    throw new ForemanError("issue-unavailable", `fabrica do: ${messageOf(err)}`);
  }

  // `issue` holds the number alone for an issue in the repository this
  // task's own pull request is opened in - the only spelling that
  // existed before this, so every reader and every already-registered
  // task keeps working - and the qualified `owner/repo#N` for one
  // somewhere else, which is also how GitHub's own closing keywords name
  // a cross-repository issue. A project whose repository can't be
  // determined at all is not qualified: nothing is known to differ, and
  // `Closes owner/repo#N` would then be a guess rather than a
  // correction.
  const own = reader.projectRepo(project);
  writeTaskFile(
    recordHome,
    taskId,
    "issue",
    own === null || sameRepo(own, ref) ? String(ref.number) : formatIssueRef(ref)
  );
  const text = renderIssueFile(issue);
  writeTaskFile(recordHome, taskId, "issue.md", text);
  return text;
}

/** `issue.md`: the fetched issue as the record keeps it, and as every
 * brief carries it. One rendering, used for both, so what a worker reads
 * and what the Client can open in the record are the same text. */
export function renderIssueFile(issue: FetchedIssue): string {
  const body = issue.body.trim();
  return (
    `# ${formatIssueRef(issue.ref)}: ${issue.title.trim()}\n\n${issue.url}\n\n` +
    `${body.length > 0 ? body : "(This issue has no description.)"}\n`
  );
}

/** The issue text this task was registered with, or null for a task that
 * named no issue. Read from the record on every round rather than
 * fetched again - the issue is frozen at registration (decision 2
 * above). */
export function taskIssueText(recordHome: string, taskId: string): string | null {
  return readTaskFile(recordHome, taskId, "issue.md");
}

/**
 * `briefText` with the task's issue appended as its own section, or
 * `briefText` unchanged when there is no issue. Applied at every point a
 * worker (or `brain.ask`) is handed words, and idempotent, so a brief
 * that already carries the issue is never given a second copy.
 *
 * Appended rather than prefixed: the Client's own words are the request,
 * and the issue is what they refer to.
 */
export function withIssueText(briefText: string, issueText: string | null | undefined): string {
  if (issueText === null || issueText === undefined || issueText.trim().length === 0) return briefText;
  if (briefText.includes(ISSUE_BRIEF_HEADER)) return briefText;
  return `${briefText}\n\n---\n\n${ISSUE_BRIEF_HEADER}\n\n${issueText.trim()}\n`;
}

/** What this task's pull request should close, as the record holds it:
 * the number for the project's own repository, `owner/repo#N` for an
 * issue explicitly pointed elsewhere. Undefined for a task that named no
 * issue, and for a record file nothing can read - a half-read number
 * would close the wrong issue. The one reader of the `issue` file, shared
 * by do.ts's round and verdict.ts's fix round so the two can never
 * disagree about what a task closes. */
export function storedClosesIssue(recordHome: string, taskId: string): ClosesIssue | undefined {
  const stored = parseStoredIssue(readTaskFile(recordHome, taskId, "issue"));
  if (stored === undefined) return undefined;
  return {
    number: stored.number,
    ...(stored.repo ? { repo: `${stored.repo.owner}/${stored.repo.repo}` } : {}),
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
