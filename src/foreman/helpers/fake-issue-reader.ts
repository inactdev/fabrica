// Test-only: an IssueReader that answers from a fixture instead of
// GitHub, so no test needs a token, a network, or a real issue - and so
// a bare `--issue N` resolves even though every fixture project's origin
// is a throwaway local mirror rather than a github.com remote.
//
// The src-side equivalent of contract/helpers/fake-inspector.ts, and the
// reason the seam is one object: see IssueReader's own comment.

import { GitHubError } from "../../github/index.ts";
import { formatIssueRef } from "../../github/index.ts";
import type { FetchedIssue, IssueRef } from "../../github/index.ts";
import type { IssueReader } from "../task-issue.ts";

export interface FakeIssueReaderOptions {
  title?: string;
  body?: string;
  /** What `projectRepo` answers for every project - the repository a
   * fixture's pull requests are pretended to be opened in. `null` stands
   * in for a project whose origin is no GitHub remote at all. */
  projectRepo?: { owner: string; repo: string } | null;
  /** Thrown instead of answering - stands in for every refusal the real
   * reader produces (no such issue, no token, an oversized one). */
  error?: Error;
}

export interface FakeIssueReader {
  reader: IssueReader;
  /** Every issue asked for, in order - so a test can prove the issue is
   * fetched once, at registration, and never again on a later round. */
  calls: IssueRef[];
}

export const FAKE_PROJECT_REPO = { owner: "fixture-owner", repo: "fixture-project" };

export function fakeIssueReader(opts: FakeIssueReaderOptions = {}): FakeIssueReader {
  const calls: IssueRef[] = [];
  return {
    calls,
    reader: {
      projectRepo: () => (opts.projectRepo === undefined ? FAKE_PROJECT_REPO : opts.projectRepo),
      issue: async (ref): Promise<FetchedIssue> => {
        calls.push(ref);
        if (opts.error) throw opts.error;
        return {
          ref,
          title: opts.title ?? `Fixture issue ${formatIssueRef(ref)}`,
          body: opts.body ?? `The fixture body of ${formatIssueRef(ref)}.`,
          url: `https://github.com/${ref.owner}/${ref.repo}/issues/${ref.number}`,
        };
      },
    },
  };
}

/** A reader that refuses the way the real one does when GitHub has no
 * such issue - for a test about what Fabrica does with a refusal, not
 * about how GitHub words one. */
export function refusingIssueReader(message: string): FakeIssueReader {
  return fakeIssueReader({ error: new GitHubError("issue-not-found", message) });
}
