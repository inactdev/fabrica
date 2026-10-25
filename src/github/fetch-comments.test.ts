// Every branch of the comments call, driven through an injected `fetch`
// - no token, no network, no real issue anywhere in this file.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMMENTS_PER_PAGE,
  MAX_COMMENT_CHARS,
  MAX_COMMENT_PAGES,
  fetchIssueComments,
} from "./fetch-comments.ts";
import { GITHUB_API_VERSION } from "./api.ts";
import type { HttpFetch } from "./api.ts";
import { GitHubError } from "./errors.ts";

const REF = { owner: "inactdev", repo: "fabrica", number: 142 };

/** One comment as GitHub's reference describes it. */
function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    html_url: "https://github.com/inactdev/fabrica/issues/142#issuecomment-1",
    user: { login: "ari", type: "User" },
    created_at: "2026-10-20T09:12:33Z",
    updated_at: "2026-10-20T09:12:33Z",
    body: "A ruling.",
    ...over,
  };
}

/** A fetch that answers each request in turn from `pages`, recording
 * every URL and header set it was given. */
function serving(pages: unknown[], status = 200) {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  let call = 0;
  const impl: HttpFetch = async (url, init) => {
    urls.push(url);
    headers.push(init.headers);
    const page = pages[Math.min(call, pages.length - 1)];
    call += 1;
    return { status, text: async () => (typeof page === "string" ? page : JSON.stringify(page)) };
  };
  return { impl, urls, headers };
}

function read(pages: unknown[], status?: number) {
  const fake = serving(pages, status);
  return { fake, result: fetchIssueComments(REF, { token: "fake-token", fetchImpl: fake.impl }) };
}

test("the documented endpoint, headers and page size", async () => {
  const { fake, result } = read([[raw()]]);
  const comments = await result;

  assert.deepEqual(fake.urls, [
    `https://api.github.com/repos/inactdev/fabrica/issues/142/comments?per_page=${COMMENTS_PER_PAGE}&page=1`,
  ]);
  assert.equal(fake.headers[0].Accept, "application/vnd.github+json");
  assert.equal(fake.headers[0].Authorization, "Bearer fake-token");
  assert.equal(fake.headers[0]["X-GitHub-Api-Version"], GITHUB_API_VERSION);
  assert.deepEqual(comments, {
    comments: [
      {
        author: "ari",
        postedAt: "2026-10-20T09:12:33Z",
        editedAt: null,
        url: "https://github.com/inactdev/fabrica/issues/142#issuecomment-1",
        body: "A ruling.",
        fullLength: null,
      },
    ],
    omittedComments: [],
  });
});

test("an issue with no comments reads as none - never as an unread issue", async () => {
  const { result } = read([[]]);
  assert.deepEqual(await result, { comments: [], omittedComments: [] });
});

// The ordering is the point of the whole section: GitHub's own order for
// this endpoint is ascending id, i.e. oldest first, and it is kept.
test("GitHub's order is kept, across pages, oldest first", async () => {
  const first = Array.from({ length: COMMENTS_PER_PAGE }, (_unused, index) =>
    raw({ id: index + 1, body: `comment ${index + 1}`, created_at: `2026-10-20T09:00:0${index % 10}Z` })
  );
  const second = [raw({ id: 101, body: "comment 101" })];
  const fake = serving([first, second]);

  const { comments } = await fetchIssueComments(REF, { token: "t", fetchImpl: fake.impl });

  assert.equal(comments.length, COMMENTS_PER_PAGE + 1);
  assert.equal(comments[0].body, "comment 1");
  assert.equal(comments.at(-1)!.body, "comment 101");
  assert.deepEqual(
    fake.urls.map((url) => url.split("&page=")[1]),
    ["1", "2"],
    "the page walk did not stop on the first short page"
  );
});

test("a full last page is followed by one more request, which ends the walk", async () => {
  const full = Array.from({ length: COMMENTS_PER_PAGE }, (_unused, index) => raw({ id: index + 1 }));
  const fake = serving([full, []]);
  const { comments } = await fetchIssueComments(REF, { token: "t", fetchImpl: fake.impl });
  assert.equal(comments.length, COMMENTS_PER_PAGE);
  assert.equal(fake.urls.length, 2);
});

test("automation's comments are left out as text but named by author and date", async () => {
  const { result } = read([
    [
      raw({ user: { login: "ari", type: "User" }, body: "the ruling" }),
      raw({ user: { login: "github-actions[bot]", type: "Bot" }, body: "CI passed", created_at: "2026-10-20T10:00:00Z" }),
      // A login that says [bot] with a type that doesn't, and the other
      // way round: either fact on its own is enough.
      raw({ user: { login: "sync-fabrica[bot]", type: "User" }, created_at: "2026-10-20T11:00:00Z" }),
      raw({ user: { login: "linter", type: "bot" }, created_at: "2026-10-20T12:00:00Z" }),
    ],
  ]);
  const { comments, omittedComments } = await result;

  assert.deepEqual(
    comments.map((comment) => comment.body),
    ["the ruling"]
  );
  assert.deepEqual(omittedComments, [
    { author: "github-actions[bot]", postedAt: "2026-10-20T10:00:00Z" },
    { author: "sync-fabrica[bot]", postedAt: "2026-10-20T11:00:00Z" },
    { author: "linter", postedAt: "2026-10-20T12:00:00Z" },
  ]);
});

test("an edited comment carries its current text and both dates", async () => {
  const { result } = read([
    [raw({ body: "the amended ruling", created_at: "2026-10-20T09:12:33Z", updated_at: "2026-10-21T14:00:00Z" })],
  ]);
  const [comment] = (await result).comments;
  assert.equal(comment.body, "the amended ruling");
  assert.equal(comment.postedAt, "2026-10-20T09:12:33Z");
  assert.equal(comment.editedAt, "2026-10-21T14:00:00Z");
});

test("a comment by a deleted account is still carried, with its author named as unknown", async () => {
  const { result } = read([[raw({ user: null, body: "a ruling from an account since deleted" })]]);
  const [comment] = (await result).comments;
  assert.equal(comment.author, "unknown");
  assert.equal(comment.body, "a ruling from an account since deleted");
});

test("a comment with no readable posted date refuses: its place in the order would be a guess", async () => {
  for (const created of [undefined, "", "not-a-date", 17]) {
    await assert.rejects(
      () => read([[raw({ created_at: created })]]).result,
      (err: unknown) => err instanceof GitHubError && err.code === "issue-comments-unreadable",
      `created_at ${JSON.stringify(created)} was accepted`
    );
  }
});

test("a non-UTC timestamp is normalized to ISO-8601 UTC, to the second", async () => {
  const { result } = read([[raw({ created_at: "2026-10-20T11:12:33+02:00", updated_at: "2026-10-20T11:12:33+02:00" })]]);
  const [comment] = (await result).comments;
  assert.equal(comment.postedAt, "2026-10-20T09:12:33Z");
  assert.equal(comment.editedAt, null, "the same moment in two spellings read as an edit");
});

test("a comment past the limit is cut, and says by whom and how much", async () => {
  const body = "x".repeat(MAX_COMMENT_CHARS + 500);
  const { result } = read([[raw({ body })]]);
  const [comment] = (await result).comments;
  assert.equal(Array.from(comment.body).length, MAX_COMMENT_CHARS);
  assert.equal(comment.fullLength, MAX_COMMENT_CHARS + 500);
});

test("exactly at the limit is not cut - the limit is a ceiling, not a target", async () => {
  const { result } = read([[raw({ body: "x".repeat(MAX_COMMENT_CHARS) })]]);
  const [comment] = (await result).comments;
  assert.equal(comment.fullLength, null);
  assert.equal(comment.body.length, MAX_COMMENT_CHARS);
});

// Counted in code points, so a cut can never land inside a surrogate
// pair and leave half a character behind.
test("a cut never splits a multi-code-point character", async () => {
  const { result } = read([[raw({ body: "😀".repeat(MAX_COMMENT_CHARS + 10) })]]);
  const [comment] = (await result).comments;
  assert.equal(Array.from(comment.body).length, MAX_COMMENT_CHARS);
  assert.ok(comment.body.endsWith("😀"), "the cut left half a character behind");
  // Two UTF-16 units per character: a cut counted in units would have
  // stopped at half this length.
  assert.equal(comment.body.length, MAX_COMMENT_CHARS * 2);
  assert.equal(comment.fullLength, MAX_COMMENT_CHARS + 10);
});

for (const status of [404, 410]) {
  test(`HTTP ${status}: the amendments could not be read, and the task is not run on half an issue`, async () => {
    await assert.rejects(
      () => read([{ message: "Not Found" }], status).result,
      (err: unknown) =>
        err instanceof GitHubError &&
        err.code === "issue-comments-fetch-failed" &&
        err.message.includes("inactdev/fabrica#142")
    );
  });
}

test("any other status carries GitHub's own explanation, not just the number", async () => {
  await assert.rejects(
    () => read([{ message: "API rate limit exceeded" }], 403).result,
    (err: unknown) =>
      err instanceof GitHubError &&
      err.code === "issue-comments-fetch-failed" &&
      err.message.includes("HTTP 403") &&
      err.message.includes("API rate limit exceeded")
  );
});

test("an unreachable GitHub is a refusal naming the cause, never an issue with no comments", async () => {
  const impl: HttpFetch = async () => {
    throw new Error("getaddrinfo ENOTFOUND api.github.com");
  };
  await assert.rejects(
    () => fetchIssueComments(REF, { token: "t", fetchImpl: impl }),
    (err: unknown) =>
      err instanceof GitHubError && err.code === "issue-comments-fetch-failed" && /ENOTFOUND/.test(err.message)
  );
});

test("an answer that is not a list of comments is unreadable, not half-read", async () => {
  for (const body of ["<html>no</html>", "null", JSON.stringify({ comments: [] }), JSON.stringify([1, 2])]) {
    await assert.rejects(
      () => read([body]).result,
      (err: unknown) => err instanceof GitHubError && err.code === "issue-comments-unreadable",
      `"${body}" was accepted`
    );
  }
});

// The runaway guard, not a cap on comments: an API that answered a full
// page forever would otherwise loop forever.
test("a page walk that never ends refuses loudly rather than looping", async () => {
  const full = Array.from({ length: COMMENTS_PER_PAGE }, (_unused, index) => raw({ id: index + 1 }));
  const fake = serving([full]);
  await assert.rejects(
    () => fetchIssueComments(REF, { token: "t", fetchImpl: fake.impl }),
    (err: unknown) =>
      err instanceof GitHubError &&
      err.code === "issue-comments-unbounded" &&
      err.message.includes(String(MAX_COMMENT_PAGES))
  );
  assert.equal(fake.urls.length, MAX_COMMENT_PAGES);
});
