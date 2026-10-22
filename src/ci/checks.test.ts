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

test("no resolvable GitHub token is an unreadable report, never a thrown error", async () => {
  const report = await readPullRequestChecks(PR_URL, {
    // An environment with no token, and a PATH with no `gh` to ask.
    env: { PATH: "/nonexistent" },
  });
  assert.equal(report?.verdict, "unreadable");
  assert.match(report?.problem ?? "", /GitHub token/);
  assert.match(report?.summary ?? "", /could not be read/);
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
