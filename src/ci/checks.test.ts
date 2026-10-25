// The module's front door: which pull requests it reads at all, and what
// it answers when it cannot read one. Nothing here writes to the record -
// that is `src/foreman/ci-checks.ts`'s job, tested there.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readPullRequestChecks } from "./checks.ts";
import { checkRun, fakeClock, startFakeGithub } from "./helpers/fake-github.ts";

const PR_URL = "https://github.com/o/r/pull/7";

test("a pull request url with no GitHub API behind it is not read at all", async () => {
  // Distinct from an "unreadable" report on purpose: there is nothing to
  // read here, which is not the same as a read that failed.
  assert.equal(await readPullRequestChecks("https://example.test/pulls/9", { token: "t" }), undefined);
});

test("no token source at all is an unreadable report, never a thrown error", async () => {
  const report = await readPullRequestChecks(PR_URL, {});
  assert.equal(report?.verdict, "unreadable");
  assert.match(report?.problem ?? "", /GitHub App token source/);
  assert.match(report?.summary ?? "", /could not be read/);
});

test("a mint that refuses is an unreadable report, never a thrown error", async () => {
  // The round's work is done by the time this runs (issue #187: Inspector
  // has already published through the same App), so a credential problem
  // here must never lose it.
  const report = await readPullRequestChecks(PR_URL, {
    mintToken: async () => {
      throw new Error("The GitHub App is not installed on o/r (GitHub answered 404)");
    },
  });
  assert.equal(report?.verdict, "unreadable");
  assert.match(report?.problem ?? "", /not installed on o\/r/);
});

test("the token is minted for the pull request's own repository, and used for every call", async () => {
  const github = await startFakeGithub({ checkRuns: [[checkRun("tests", "success")]] });
  try {
    const clock = fakeClock();
    const scopes: string[] = [];
    const report = await readPullRequestChecks(PR_URL, {
      mintToken: async (ref) => {
        scopes.push(`${ref.owner}/${ref.repo}`);
        return "minted0";
      },
      baseUrl: github.baseUrl,
      now: clock.now,
      sleep: clock.sleep,
    });
    assert.equal(report?.verdict, "green");
    // One mint for the whole poll, scoped to the pull request's repo -
    // not one per tick (see ReadChecksOptions.mintToken).
    assert.deepEqual(scopes, ["o/r"]);
    assert.ok(
      github.requests.every((request) => request.path.startsWith("/blob/") || request.authorization === "Bearer minted0"),
      "an API call went out without the minted token"
    );
  } finally {
    await github.close();
  }
});

test("a github.com pull request is read with the token it was given", async () => {
  const github = await startFakeGithub({ checkRuns: [[checkRun("tests", "success")]] });
  try {
    const clock = fakeClock();
    const report = await readPullRequestChecks(PR_URL, {
      token: "t0ken",
      baseUrl: github.baseUrl,
      now: clock.now,
      sleep: clock.sleep,
    });
    assert.equal(report?.verdict, "green");
    assert.equal(report?.prUrl, PR_URL);
    assert.ok(
      github.requests.every((request) => request.path.startsWith("/blob/") || request.authorization === "Bearer t0ken"),
      "an API call went out without the token"
    );
  } finally {
    await github.close();
  }
});
