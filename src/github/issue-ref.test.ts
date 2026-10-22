import { test } from "node:test";
import assert from "node:assert/strict";
import { formatIssueRef, parseIssueArg, parseStoredIssue, sameRepo } from "./issue-ref.ts";
import { GitHubError } from "./errors.ts";

test("parseIssueArg: a number, or text spelling one, names no repository", () => {
  assert.deepEqual(parseIssueArg(186), { number: 186 });
  assert.deepEqual(parseIssueArg("186"), { number: 186 });
  assert.deepEqual(parseIssueArg("#186"), { number: 186 });
  assert.deepEqual(parseIssueArg("  186  "), { number: 186 });
});

test("parseIssueArg: owner/repo#N names the repository explicitly", () => {
  assert.deepEqual(parseIssueArg("inactdev/inspector#45"), {
    number: 45,
    repo: { owner: "inactdev", repo: "inspector" },
  });
});

test("parseIssueArg: a pasted issue URL names the same thing", () => {
  const expected = { number: 142, repo: { owner: "inactdev", repo: "fabrica" } };
  assert.deepEqual(parseIssueArg("https://github.com/inactdev/fabrica/issues/142"), expected);
  assert.deepEqual(parseIssueArg("http://github.com/inactdev/fabrica/issues/142"), expected);
  assert.deepEqual(parseIssueArg("https://www.github.com/inactdev/fabrica/issues/142"), expected);
  assert.deepEqual(
    parseIssueArg("https://github.com/inactdev/fabrica/issues/142#issuecomment-99"),
    expected,
    "a link to a comment on the issue still names the issue"
  );
});

test("parseIssueArg: every refusal names the three forms it accepts", () => {
  for (const value of ["0", 0, -3, "1.5", "", "fabrica#", "#abc", "https://github.com/inactdev/fabrica/pull/4", "issue 186"] as const) {
    assert.throws(
      () => parseIssueArg(value),
      (err: unknown) =>
        err instanceof GitHubError &&
        err.code === "issue-ref-unparsable" &&
        /owner\/repo#N/.test(err.message) &&
        /GitHub issue URL/.test(err.message),
      `"${value}" was accepted, or refused without instructions`
    );
  }
});

test("formatIssueRef and sameRepo: a repository's case is not a different repository", () => {
  assert.equal(formatIssueRef({ owner: "inactdev", repo: "fabrica", number: 7 }), "inactdev/fabrica#7");
  assert.ok(sameRepo({ owner: "inactdev", repo: "fabrica" }, { owner: "InactDev", repo: "Fabrica" }));
  assert.ok(!sameRepo({ owner: "inactdev", repo: "fabrica" }, { owner: "inactdev", repo: "inspector" }));
});

test("parseStoredIssue reads both spellings the record ever holds, and nothing else", () => {
  assert.deepEqual(parseStoredIssue("186"), { number: 186 }, "the only form written before this existed");
  assert.deepEqual(parseStoredIssue("inactdev/inspector#45"), {
    number: 45,
    repo: { owner: "inactdev", repo: "inspector" },
  });
  for (const raw of [null, undefined, "", "   ", "not a number", "owner/repo#"]) {
    assert.equal(parseStoredIssue(raw), undefined, `"${raw}" was half-read instead of refused`);
  }
});
