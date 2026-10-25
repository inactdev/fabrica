// The task-facing half of issue #187: which repository a project's
// tokens are scoped to, and the record entry every mint leaves behind.
//
// The record writing is tested through the wrapper every caller uses
// (`recordingMinter`), not through the real GitHub App - that is the
// whole point of the split in `github-token.ts`'s header: a fake minter
// still proves the event.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForemanError } from "./errors.ts";
import { defaultChecksReader } from "./ci-checks.ts";
import { defaultIssueReader } from "./task-issue.ts";
import { githubRepoOf, projectRepo, publishToken, readChecksScope, readIssueScope, recordingMinter } from "./github-token.ts";
import { fakeMinter } from "../githubapp/helpers/fake-minter.ts";
import { PUBLISH_PERMISSIONS } from "../githubapp/index.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { readEvents } from "../record/index.ts";

function home(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-gh-token-home-"));
}

/** A fixture project whose `origin` is a github.com URL. The default
 * fixture points origin at a throwaway local bare mirror, which is the
 * right default for every other suite and the wrong one here. */
function projectOn(originUrl: string): string {
  const project = makeFixtureRepo("exit 0", { origin: false });
  execFileSync("git", ["remote", "add", "origin", originUrl], { cwd: project });
  return project;
}

test("a project's repository is read from its origin remote, https and ssh alike", () => {
  assert.deepEqual(projectRepo(projectOn("https://github.com/acme/widgets.git")), { owner: "acme", repo: "widgets" });
  assert.deepEqual(projectRepo(projectOn("git@github.com:acme/widgets.git")), { owner: "acme", repo: "widgets" });
});

test("no origin at all: refused, naming what to do about it", () => {
  const project = makeFixtureRepo("exit 0", { origin: false });

  assert.throws(
    () => projectRepo(project),
    (err: unknown) => err instanceof ForemanError && err.code === "no-github-repo" && /git remote add origin/.test(err.message)
  );
});

test("an origin on another host: refused, saying Fabrica has no credential for it", () => {
  assert.throws(
    () => projectRepo(projectOn("https://git.example.test/acme/widgets.git")),
    (err: unknown) =>
      err instanceof ForemanError && err.code === "no-github-repo" && /not on github.com/.test(err.message)
  );
});

test("githubRepoOf answers null where projectRepo refuses, for the check that reports on every project", () => {
  assert.equal(githubRepoOf(makeFixtureRepo("exit 0", { origin: false })), null);
  assert.deepEqual(githubRepoOf(projectOn("https://github.com/acme/widgets.git")), { owner: "acme", repo: "widgets" });
});

test("every mint lands one `token-minted` event on the task, and the token is never in it", async () => {
  const recordHome = home();
  const minter = recordingMinter(recordHome, "task-1", fakeMinter({ token: "ghs_secret_value" }));

  await minter.mint("publish", { owner: "acme", repo: "widgets", permissions: PUBLISH_PERMISSIONS });
  await minter.mint("read-issue", readIssueScope("acme", "widgets"));
  await minter.mint("read-checks", readChecksScope("acme", "widgets"));

  const events = readEvents(recordHome).filter((e) => e.name === "token-minted");
  assert.equal(events.length, 3);
  assert.deepEqual(events[0].details, {
    purpose: "publish",
    repo: "acme/widgets",
    installationId: 42,
    permissions: "contents: write, pull_requests: write",
    expiresAt: "2026-01-01T01:00:00Z",
    repositorySelection: "selected",
  });
  assert.equal((events[1].details as { permissions: string }).permissions, "issues: read");
  assert.equal(
    (events[2].details as { permissions: string }).permissions,
    "actions: read, checks: read, pull_requests: read, statuses: read"
  );
  assert.ok(!JSON.stringify(events).includes("ghs_secret_value"), "the record carried the token itself");
  assert.ok(events.every((e) => e.taskId === "task-1"));
});

test("a mint that refuses records nothing - there was no token to report", async () => {
  const recordHome = home();
  const minter = recordingMinter(
    recordHome,
    "task-1",
    fakeMinter({ refuseMint: new Error("GitHub refused to mint a token") })
  );

  await assert.rejects(() => minter.mint("publish", { owner: "acme", repo: "widgets", permissions: PUBLISH_PERMISSIONS }));

  assert.deepEqual(readEvents(recordHome).filter((e) => e.name === "token-minted"), []);
});

test("the publishing token refuses a project with no GitHub repository, before it asks about the App", () => {
  const minter = fakeMinter();
  const token = publishToken(home(), "task-1", makeFixtureRepo("exit 0", { origin: false }), minter);

  assert.throws(() => token.check(), (err: unknown) => err instanceof ForemanError && err.code === "no-github-repo");
  assert.equal(minter.calls.length, 0);
});

test("the publishing token mints for the project's own repository, with only the two publish permissions", async () => {
  const recordHome = home();
  const minter = fakeMinter();
  const token = publishToken(recordHome, "task-1", projectOn("https://github.com/acme/widgets.git"), minter);

  token.check();
  const minted = await token.mint();

  assert.equal(minted.token, "fake-installation-token");
  assert.deepEqual(minter.calls, [
    { purpose: "publish", scope: { owner: "acme", repo: "widgets", permissions: PUBLISH_PERMISSIONS } },
  ]);
  assert.equal(readEvents(recordHome).filter((e) => e.name === "token-minted").length, 1);
});

test("`check()` asks nothing of GitHub, so it can refuse a task before any worker starts", () => {
  const minter = fakeMinter();
  publishToken(home(), "task-1", projectOn("https://github.com/acme/widgets.git"), minter).check();

  assert.equal(minter.calls.length, 0);
});

// The other two production readers take the same `minter` seam
// `createForeman`'s `minter` option is threaded into, and both consult it
// before making any request at all - so a refusing minter proves the
// wiring without a network call.

test("the issue reader mints for the ISSUE's repository, not the project's, and says so when it cannot", async () => {
  const minter = fakeMinter({ refuseMint: new Error("The GitHub App is not installed on other/place") });
  const reader = defaultIssueReader(home(), "task-1", minter);

  await assert.rejects(
    () => reader.issue({ owner: "other", repo: "place", number: 9 }),
    (err: unknown) => err instanceof Error && /needs a GitHub App token for other\/place/.test(err.message)
  );
  // `owner/repo#N` can name an issue anywhere; a token minted for the
  // project would be a token for the wrong repository.
  assert.deepEqual(minter.calls, [
    { purpose: "read-issue", scope: readIssueScope("other", "place") },
  ]);
});

test("the checks reader mints for the pull request's repository, and a refused mint is an unreadable report", async () => {
  const recordHome = home();
  const minter = fakeMinter({ refuseMint: new Error("GitHub refused to mint a token for acme/widgets") });

  const report = await defaultChecksReader(recordHome, "task-1", minter)(
    "https://github.com/acme/widgets/pull/7",
    () => {}
  );

  // The round's work is done by the time this runs; a credential problem
  // must never lose it.
  assert.equal(report?.verdict, "unreadable");
  assert.match(report?.problem ?? "", /refused to mint/);
  assert.deepEqual(minter.calls, [{ purpose: "read-checks", scope: readChecksScope("acme", "widgets") }]);
});
