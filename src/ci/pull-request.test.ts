// Which URLs are read back over the GitHub API and which are left alone.
// The negative cases matter as much as the positive one: a URL this
// function accepts wrongly would send a GitHub token at a host that is
// not GitHub, and one it rejects wrongly silently stops every CI read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePullRequestUrl } from "./pull-request.ts";

test("parsePullRequestUrl reads owner, repo and number from a github.com pull request url", () => {
  assert.deepEqual(parsePullRequestUrl("https://github.com/inactdev/fabrica/pull/267"), {
    owner: "inactdev",
    repo: "fabrica",
    number: 267,
  });
});

test("parsePullRequestUrl ignores extra path segments, a query and a fragment", () => {
  for (const url of [
    "https://github.com/inactdev/fabrica/pull/267/files",
    "https://github.com/inactdev/fabrica/pull/267?w=1",
    "https://github.com/inactdev/fabrica/pull/267#issuecomment-1",
    "https://www.github.com/inactdev/fabrica/pull/267",
  ]) {
    assert.deepEqual(parsePullRequestUrl(url), { owner: "inactdev", repo: "fabrica", number: 267 }, url);
  }
});

test("parsePullRequestUrl refuses anything that is not a github.com pull request", () => {
  for (const url of [
    // The shape Inspector's own test fixtures print - no GitHub API
    // behind it, so nothing is polled and nothing is recorded.
    "https://example.test/pulls/9",
    // A look-alike host: accepting this would hand a GitHub token to
    // somebody else's server.
    "https://github.com.evil.test/inactdev/fabrica/pull/1",
    "https://gitlab.com/inactdev/fabrica/pull/1",
    "https://github.com/inactdev/fabrica/issues/267",
    "https://github.com/inactdev/fabrica/pull/not-a-number",
    "https://github.com/inactdev/fabrica/pull",
    "https://github.com/inactdev/fabrica/pull/0",
    "ssh://github.com/inactdev/fabrica/pull/1",
    "not a url at all",
    "",
  ]) {
    assert.equal(parsePullRequestUrl(url), null, url);
  }
});
