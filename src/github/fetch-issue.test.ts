// Every branch of the two GitHub calls Fabrica makes for a task's issue
// - its own text here, its comments in fetch-comments.test.ts - driven
// through an injected `fetch`: no token, no network, no real issue
// anywhere in this file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchIssue, githubIssueSource, GITHUB_API_VERSION, MAX_ISSUE_BYTES } from "./fetch-issue.ts";
import type { HttpFetch } from "./fetch-issue.ts";
import { GitHubError } from "./errors.ts";

const REF = { owner: "inactdev", repo: "fabrica", number: 142 };

/** A fixed clock, so `fetchedAt` is the same text on every run. */
const NOW = () => new Date("2026-10-25T09:00:00.000Z");

/** Answers the issue request with `body` and `status`, and the comments
 * request that follows it with `comments` - the second call is part of
 * reading an issue now, so a fake that answered only the first would
 * fail every test here for the wrong reason. */
function answering(
  status: number,
  body: unknown,
  comments: unknown[] = []
): { impl: HttpFetch; urls: string[]; headers: Record<string, string>[] } {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  return {
    urls,
    headers,
    impl: async (url, init) => {
      urls.push(url);
      headers.push(init.headers);
      if (url.includes("/comments")) return { status: 200, text: async () => JSON.stringify(comments) };
      return { status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
    },
  };
}

/** Every URL asked for that was not the comments page - what the tests
 * about the issue call itself assert on. */
function issueUrls(urls: string[]): string[] {
  return urls.filter((url) => !url.includes("/comments"));
}

test("the documented endpoint, headers and fields", async () => {
  const fake = answering(200, {
    number: 142,
    title: "Carry the issue into the brief",
    body: "Fetch it once, at registration.",
    html_url: "https://github.com/inactdev/fabrica/issues/142",
  });

  const issue = await fetchIssue(REF, { token: "fake-token", fetchImpl: fake.impl, now: NOW });

  assert.deepEqual(issueUrls(fake.urls), ["https://api.github.com/repos/inactdev/fabrica/issues/142"]);
  assert.equal(fake.headers[0].Accept, "application/vnd.github+json");
  assert.equal(fake.headers[0].Authorization, "Bearer fake-token");
  assert.equal(fake.headers[0]["X-GitHub-Api-Version"], GITHUB_API_VERSION);
  assert.deepEqual(issue, {
    ref: REF,
    title: "Carry the issue into the brief",
    body: "Fetch it once, at registration.",
    url: "https://github.com/inactdev/fabrica/issues/142",
    comments: [],
    omittedComments: [],
    fetchedAt: "2026-10-25T09:00:00Z",
  });
});

// The issue as it stands, not as it was first written: the comments come
// back on the same read, so no caller can forget to ask for them.
test("an issue's comments come back with it, in order", async () => {
  const fake = answering(
    200,
    { number: 142, title: "t", body: "b", html_url: "u" },
    [
      {
        user: { login: "ari", type: "User" },
        created_at: "2026-10-21T08:00:00Z",
        updated_at: "2026-10-21T08:00:00Z",
        body: "the first amendment",
        html_url: "c1",
      },
      {
        user: { login: "ci[bot]", type: "Bot" },
        created_at: "2026-10-21T09:00:00Z",
        updated_at: "2026-10-21T09:00:00Z",
        body: "green",
        html_url: "c2",
      },
    ]
  );

  const issue = await fetchIssue(REF, { token: "t", fetchImpl: fake.impl, now: NOW });

  assert.deepEqual(
    issue.comments.map((comment) => comment.body),
    ["the first amendment"]
  );
  assert.deepEqual(issue.omittedComments, [{ author: "ci[bot]", postedAt: "2026-10-21T09:00:00Z" }]);
  assert.ok(
    fake.urls.some((url) => url.includes("/issues/142/comments?")),
    "the comments were never asked for"
  );
});

// An issue refused on its own text is refused before a second request is
// made at all - there is nothing to read the comments for.
test("a refused issue costs no comments request", async () => {
  const fake = answering(200, { number: 142, title: "big", body: "x".repeat(MAX_ISSUE_BYTES + 1), html_url: "u" });
  await assert.rejects(() => fetchIssue(REF, { token: "t", fetchImpl: fake.impl }));
  assert.deepEqual(
    fake.urls.filter((url) => url.includes("/comments")),
    []
  );
});

// A comments call that fails refuses the whole read: an issue handed over
// without its amendments is a superseded request, and nothing
// downstream would know.
test("unreadable comments refuse the issue rather than quietly dropping them", async () => {
  const impl: HttpFetch = async (url) =>
    url.includes("/comments")
      ? { status: 403, text: async () => JSON.stringify({ message: "API rate limit exceeded" }) }
      : { status: 200, text: async () => JSON.stringify({ number: 142, title: "t", body: "b", html_url: "u" }) };

  await assert.rejects(
    () => fetchIssue(REF, { token: "t", fetchImpl: impl }),
    (err: unknown) => err instanceof GitHubError && err.code === "issue-comments-fetch-failed"
  );
});

test("an issue with no description reads as an empty body, never the word null", async () => {
  const fake = answering(200, { number: 142, title: "Just a title", body: null, html_url: "u" });
  const issue = await fetchIssue(REF, { token: "t", fetchImpl: fake.impl });
  assert.equal(issue.body, "");
});

test("githubIssueSource reads the same issue through the IssueSource seam", async () => {
  const fake = answering(200, { number: 142, title: "t", body: "b", html_url: "u" });
  const source = githubIssueSource({ token: "t", fetchImpl: fake.impl, apiRoot: "https://example.test" });
  const issue = await source(REF);
  assert.equal(issue.title, "t");
  assert.deepEqual(issueUrls(fake.urls), ["https://example.test/repos/inactdev/fabrica/issues/142"]);
  assert.ok(
    fake.urls.some((url) => url.startsWith("https://example.test/repos/inactdev/fabrica/issues/142/comments?")),
    "the comments call ignored the api root"
  );
});

for (const status of [404, 410]) {
  test(`HTTP ${status}: no such issue this token can read, said as such`, async () => {
    const fake = answering(status, { message: "Not Found" });
    await assert.rejects(
      () => fetchIssue(REF, { token: "t", fetchImpl: fake.impl }),
      (err: unknown) =>
        err instanceof GitHubError && err.code === "issue-not-found" && err.message.includes("inactdev/fabrica#142")
    );
  });
}

test("HTTP 301: the issue was transferred, and the refusal says where to look", async () => {
  const fake = answering(301, {});
  await assert.rejects(
    () => fetchIssue(REF, { token: "t", fetchImpl: fake.impl }),
    (err: unknown) => err instanceof GitHubError && err.code === "issue-moved" && /owner\/repo#N/.test(err.message)
  );
});

test("any other status carries GitHub's own explanation, not just the number", async () => {
  const fake = answering(403, { message: "Bad credentials" });
  await assert.rejects(
    () => fetchIssue(REF, { token: "t", fetchImpl: fake.impl }),
    (err: unknown) =>
      err instanceof GitHubError &&
      err.code === "issue-fetch-failed" &&
      err.message.includes("HTTP 403") &&
      err.message.includes("Bad credentials")
  );
});

test("an unreachable GitHub is a refusal naming the cause, never an empty issue", async () => {
  const impl: HttpFetch = async () => {
    throw new Error("getaddrinfo ENOTFOUND api.github.com");
  };
  await assert.rejects(
    () => fetchIssue(REF, { token: "t", fetchImpl: impl }),
    (err: unknown) => err instanceof GitHubError && err.code === "issue-fetch-failed" && /ENOTFOUND/.test(err.message)
  );
});

test("a pull request is not an issue, however the API returns it", async () => {
  const fake = answering(200, { number: 142, title: "a pull request", body: "", pull_request: { url: "..." } });
  await assert.rejects(
    () => fetchIssue(REF, { token: "t", fetchImpl: fake.impl }),
    (err: unknown) => err instanceof GitHubError && err.code === "issue-is-pull-request"
  );
});

test("an answer that is not an issue is unreadable, not half-read", async () => {
  for (const body of ["<html>no</html>", "null", JSON.stringify({ number: 142 })]) {
    const fake = answering(200, body);
    await assert.rejects(
      () => fetchIssue(REF, { token: "t", fetchImpl: fake.impl }),
      (err: unknown) => err instanceof GitHubError && err.code === "issue-unreadable",
      `"${body}" was accepted`
    );
  }
});

test("past the 64 KB ceiling: refused, naming the real size - never truncated", async () => {
  const body = "x".repeat(MAX_ISSUE_BYTES + 1);
  const fake = answering(200, { number: 142, title: "big", body, html_url: "u" });
  await assert.rejects(
    () => fetchIssue(REF, { token: "t", fetchImpl: fake.impl }),
    (err: unknown) =>
      err instanceof GitHubError &&
      err.code === "issue-too-large" &&
      err.message.includes(String(Buffer.byteLength("big") + body.length)) &&
      err.message.includes(String(MAX_ISSUE_BYTES))
  );
});

test("exactly at the ceiling is fine - the cap is a ceiling, not a target", async () => {
  const body = "x".repeat(MAX_ISSUE_BYTES - 1);
  const fake = answering(200, { number: 142, title: "b", body, html_url: "u" });
  const issue = await fetchIssue(REF, { token: "t", fetchImpl: fake.impl });
  assert.equal(Buffer.byteLength(issue.title) + Buffer.byteLength(issue.body), MAX_ISSUE_BYTES);
});

test("a multi-byte issue is measured in bytes, not characters", async () => {
  // Four bytes each, so a body of a quarter of the cap's character count
  // plus one is over it - a character count would call this well under.
  const body = "😀".repeat(MAX_ISSUE_BYTES / 4);
  const fake = answering(200, { number: 142, title: "t", body, html_url: "u" });
  await assert.rejects(
    () => fetchIssue(REF, { token: "t", fetchImpl: fake.impl }),
    (err: unknown) => err instanceof GitHubError && err.code === "issue-too-large"
  );
});
