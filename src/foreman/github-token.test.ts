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
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForemanError } from "./errors.ts";
import { defaultChecksReader } from "./ci-checks.ts";
import { defaultIssueReader } from "./task-issue.ts";
import {
  githubRepoOf,
  projectRepo,
  publishToken,
  readChecksScope,
  readIssueScope,
  recordingMinter,
  taskGithubCredential,
} from "./github-token.ts";
import { fakeMinter } from "../githubapp/helpers/fake-minter.ts";
import { PUBLISH_PERMISSIONS } from "../githubapp/index.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { readEvents } from "../record/index.ts";
import { brainEnvPath } from "../brain/index.ts";

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
    permissions: "contents: write, pull_requests: write, statuses: write",
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

test("the publishing token mints for the project's own repository, with only the three publish permissions", async () => {
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
  const reader = defaultIssueReader(home(), "task-1", projectOn("https://github.com/acme/widgets.git"), minter);

  await assert.rejects(
    () => reader.issue({ owner: "other", repo: "place", number: 9 }),
    (err: unknown) => err instanceof Error && /needs a GitHub token for other\/place/.test(err.message)
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

  const report = await defaultChecksReader(recordHome, "task-1", projectOn("https://github.com/acme/widgets.git"), minter)(
    "https://github.com/acme/widgets/pull/7",
    () => {}
  );

  // The round's work is done by the time this runs; a credential problem
  // must never lose it.
  assert.equal(report?.verdict, "unreadable");
  assert.match(report?.problem ?? "", /refused to mint/);
  assert.deepEqual(minter.calls, [{ purpose: "read-checks", scope: readChecksScope("acme", "widgets") }]);
});

// Issue #314, work mode: a project whose projects.toml entry names the
// brain.env variable holding its own GitHub token. The App is never
// reached for such a project - not for the push, not for the issue, not
// for the pull request's checks - and `fakeMinter`'s own call list is
// what proves it, since a fake that was never asked records nothing.

const TOKEN_VAR = "DAYJOB_GITHUB_TOKEN";

/** A record home registering `project` as a work-mode project, with its
 * token in `brain.env` at mode 600 - the one place a real machine keeps
 * it. */
function workModeHome(project: string, token: string | null = "github_pat_fake"): string {
  const recordHome = home();
  writeFileSync(
    join(recordHome, "projects.toml"),
    `[projects.dayjob]\npath = "${project}"\ncheck = "./check.sh"\ngithubTokenVar = "${TOKEN_VAR}"\n`
  );
  writeFileSync(brainEnvPath(recordHome), token === null ? "SOMETHING_ELSE=x\n" : `${TOKEN_VAR}=${token}\n`);
  chmodSync(brainEnvPath(recordHome), 0o600);
  return recordHome;
}

test("a work-mode project publishes with its own token, and no App token is minted at all", async () => {
  const project = projectOn("https://github.com/acme/widgets.git");
  const recordHome = workModeHome(project);
  const minter = fakeMinter();
  const token = publishToken(recordHome, "task-1", project, minter);

  token.check();
  const published = await token.mint();

  assert.equal(published.token, "github_pat_fake");
  assert.deepEqual(minter.calls, [], "the GitHub App was asked for a token for a work-mode project");
  assert.deepEqual(readEvents(recordHome).filter((e) => e.name === "token-minted"), []);
});

test("every GitHub operation for the project goes through that token - the issue and the checks too", async () => {
  const project = projectOn("https://github.com/acme/widgets.git");
  const recordHome = workModeHome(project);
  const credential = taskGithubCredential(recordHome, "task-1", project, fakeMinter());

  assert.equal(await credential.token("publish", { owner: "acme", repo: "widgets", permissions: PUBLISH_PERMISSIONS }), "github_pat_fake");
  assert.equal(await credential.token("read-issue", readIssueScope("acme", "widgets")), "github_pat_fake");
  assert.equal(await credential.token("read-checks", readChecksScope("acme", "widgets")), "github_pat_fake");

  assert.deepEqual(
    readEvents(recordHome)
      .filter((e) => e.name === "project-token-used")
      .map((e) => (e.details as { purpose: string }).purpose),
    ["publish", "read-issue", "read-checks"]
  );
});

// Both readers are proved against a work-mode project whose token is
// missing, rather than one whose token is there: a refusal lands before
// either of them makes a request, so this asks nothing of the network
// (an unreachable github.com otherwise costs five seconds per reader)
// while still proving which credential each one asked for - the App's
// own fake was never called, and the refusal names the variable.

test("the issue read asks this project's own credential, not the App's", async () => {
  const project = projectOn("https://github.com/acme/widgets.git");
  const recordHome = workModeHome(project, null);
  const minter = fakeMinter();

  await assert.rejects(
    () => defaultIssueReader(recordHome, "task-1", project, minter).issue({ owner: "acme", repo: "widgets", number: 9 }),
    (err: unknown) => err instanceof Error && new RegExp(`${TOKEN_VAR} is not set`).test(err.message)
  );
  assert.deepEqual(minter.calls, [], "the GitHub App was asked for a token for a work-mode project");
});

test("the pull request's checks read asks it too, and an unavailable token is an unreadable report", async () => {
  const project = projectOn("https://github.com/acme/widgets.git");
  const recordHome = workModeHome(project, null);
  const minter = fakeMinter();

  const report = await defaultChecksReader(recordHome, "task-1", project, minter)(
    "https://github.com/acme/widgets/pull/7",
    () => {}
  );

  // The round's work is done by the time this runs; a credential problem
  // must never lose it.
  assert.equal(report?.verdict, "unreadable");
  assert.match(report?.problem ?? "", new RegExp(`${TOKEN_VAR} is not set`));
  assert.deepEqual(minter.calls, [], "the GitHub App was asked for a token for a work-mode project");
});

test("`project-token-used` carries the variable's name and never the token", async () => {
  const project = projectOn("https://github.com/acme/widgets.git");
  const recordHome = workModeHome(project, "github_pat_secret_value");

  await publishToken(recordHome, "task-1", project, fakeMinter()).mint();

  const events = readEvents(recordHome).filter((e) => e.name === "project-token-used");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].details, { purpose: "publish", repo: "acme/widgets", variable: TOKEN_VAR });
  assert.ok(!JSON.stringify(events).includes("github_pat_secret_value"), "the record carried the token itself");
  assert.equal(events[0].taskId, "task-1");
});

test("a named token that is set nowhere refuses before any worker starts, and never falls back to the App", async () => {
  const project = projectOn("https://github.com/acme/widgets.git");
  const recordHome = workModeHome(project, null);
  const minter = fakeMinter();
  const token = publishToken(recordHome, "task-1", project, minter);

  assert.throws(
    () => token.check(),
    (err: unknown) =>
      err instanceof ForemanError &&
      err.code === "project-token-unavailable" &&
      new RegExp(`${TOKEN_VAR} is not set`).test(err.message)
  );
  await assert.rejects(() => token.mint(), (err: unknown) => err instanceof ForemanError);
  assert.deepEqual(minter.calls, [], "the GitHub App was reached for a project that names its own token");
});

test("a work-mode project asks nothing of the GitHub App's own configuration", () => {
  const project = projectOn("https://github.com/acme/widgets.git");
  const recordHome = workModeHome(project);
  // The shape of a machine with no App configured at all: on the machine
  // this setting exists for, the App cannot be installed, and that is
  // not an error (issue #314's clarification).
  const minter = fakeMinter({ refuse: new Error("No GitHub App is configured") });

  publishToken(recordHome, "task-1", project, minter).check();
});
