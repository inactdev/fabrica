// Issue #304's task-start gate: a task whose work could never be
// published must never be worked.
//
// Driven with a fake minter throughout - the GitHub side of the same
// question is `src/githubapp/publish-permissions.test.ts`, against a stub
// GitHub - because what this file is about is the gate's decisions: which
// findings refuse, which deliberately do not, and that nothing runs after
// one that does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createForeman } from "./foreman.ts";
import { ForemanError } from "./errors.ts";
import { requirePublishPermissions } from "./publish-permissions.ts";
import { fakeMinter } from "../githubapp/helpers/fake-minter.ts";
import { PUBLISH_PERMISSIONS } from "../githubapp/index.ts";
import { fakeGh, noGh } from "../projecttoken/helpers/fake-gh.ts";
import type { HttpFetch } from "../github/index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { readEvents, registerTask } from "../record/index.ts";
import type { TokenMintedDetails } from "./github-token.ts";

function home(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-publish-gate-home-"));
}

/** A fixture project whose `origin` is a github.com URL - the default
 * fixture points origin at a throwaway local bare mirror, which is the
 * right default everywhere else and the wrong one here. */
function githubProject(): string {
  const project = makeFixtureRepo("exit 0", { origin: false });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], { cwd: project });
  return project;
}

/** A grant short of exactly what cost four green tasks their publication
 * on 2026-10-27. */
const WITHOUT_STATUSES = { contents: "write", pull_requests: "write" };

test("a grant carrying everything publishing needs lets the task through", async () => {
  const recordHome = home();
  const { id: taskId } = registerTask(recordHome, "small change");

  await requirePublishPermissions(recordHome, taskId, githubProject(), fakeMinter());

  assert.ok(true, "nothing was thrown");
});

test("a grant missing statuses: write refuses, naming it and the exact App setting", async () => {
  const recordHome = home();
  const { id: taskId } = registerTask(recordHome, "small change");

  await assert.rejects(
    () => requirePublishPermissions(recordHome, taskId, githubProject(), fakeMinter({ granted: WITHOUT_STATUSES })),
    (err: unknown) =>
      err instanceof ForemanError &&
      err.code === "publish-not-permitted" &&
      /statuses: write/.test(err.message) &&
      /Permissions & events -> Repository permissions -> Commit statuses -> Read and write/.test(err.message) &&
      /accept the permission change on the installation/.test(err.message) &&
      /Nothing was started/.test(err.message)
  );
});

test("the gate's own mint lands on the task's record, like every other mint", async () => {
  const recordHome = home();
  const { id: taskId } = registerTask(recordHome, "small change");

  await requirePublishPermissions(recordHome, taskId, githubProject(), fakeMinter());

  const minted = readEvents(recordHome).filter((event) => event.name === "token-minted");
  assert.equal(minted.length, 1);
  const details = minted[0].details as unknown as TokenMintedDetails;
  assert.equal(details.purpose, "publish");
  assert.equal(details.repo, "acme/widgets");
  // Never the token itself - the one rule every mint record keeps.
  assert.ok(!JSON.stringify(minted[0]).includes("fake-installation-token"));
});

test("a refusal is recorded too - the mint happened before it", async () => {
  const recordHome = home();
  const { id: taskId } = registerTask(recordHome, "small change");

  await assert.rejects(() =>
    requirePublishPermissions(recordHome, taskId, githubProject(), fakeMinter({ granted: WITHOUT_STATUSES }))
  );

  assert.equal(readEvents(recordHome).filter((event) => event.name === "token-minted").length, 1);
});

test("exactly the publish scope is asked for - one repository, nothing wider", async () => {
  const recordHome = home();
  const { id: taskId } = registerTask(recordHome, "small change");
  const minter = fakeMinter();

  await requirePublishPermissions(recordHome, taskId, githubProject(), minter);

  assert.deepEqual(minter.calls, [
    { purpose: "publish", scope: { owner: "acme", repo: "widgets", permissions: PUBLISH_PERMISSIONS } },
  ]);
});

test("a project with no github.com repository is let through, and nothing is minted for it", async () => {
  // A project checked by check.sh alone publishes nothing at all
  // (judge.ts's self-test mode) and legitimately has no App token in
  // play, so there is no grant to read and nothing to refuse.
  const recordHome = home();
  const { id: taskId } = registerTask(recordHome, "small change");
  const minter = fakeMinter();

  await requirePublishPermissions(recordHome, taskId, makeFixtureRepo("exit 0", { origin: false }), minter);

  assert.equal(minter.calls.length, 0);
});

test("a check that could not be taken is not a refusal: no App configured lets the task through", async () => {
  // The absence of evidence is not evidence of a shortfall. This case
  // already refuses loudly where it matters - publishToken's check(),
  // from Inspector.prepare(), before any push - and `fabrica doctor`
  // reports it to the one person who can act on it.
  const recordHome = home();
  const { id: taskId } = registerTask(recordHome, "small change");

  await requirePublishPermissions(
    recordHome,
    taskId,
    githubProject(),
    fakeMinter({ refuse: new Error("No GitHub App is configured") })
  );

  assert.ok(true, "nothing was thrown");
});

test("GitHub being unreachable is not a refusal either", async () => {
  const recordHome = home();
  const { id: taskId } = registerTask(recordHome, "small change");

  await requirePublishPermissions(
    recordHome,
    taskId,
    githubProject(),
    fakeMinter({ refuseMint: new Error("GitHub did not answer POST /app/installations/7/access_tokens") })
  );

  assert.ok(true, "nothing was thrown");
});

test("fabrica do refuses at task start, before any machine runs", async () => {
  const recordHome = home();
  const brain = fakeBrain();
  const foreman = createForeman({ recordHome, minter: fakeMinter({ granted: WITHOUT_STATUSES }) });

  await assert.rejects(
    () => foreman.do("small change", { project: githubProject(), brain }),
    (err: unknown) => err instanceof ForemanError && err.code === "publish-not-permitted"
  );

  // Not one model call, not the clarifying step either: the gate sits
  // ahead of brain.ask().
  assert.equal(brain.calls, 0, "a worker ran on a task that could never be published");
  const events = readEvents(recordHome);
  assert.ok(!events.some((event) => event.name === "work-started"), "work started before the refusal");
  assert.ok(!events.some((event) => event.name === "line-cut"), "a ProductionLine was cut for a task that cannot publish");
  // Recorded, so `fabrica log <id>` says what happened - registerAndAsk
  // wraps its body in recordingFailure, which appends "task-failed"
  // with this exact message.
  const failed = events.find((event) => event.name === "task-failed");
  assert.ok(failed !== undefined, "the refusal left no trace on the record");
  assert.match(String((failed.details as { message?: unknown }).message), /Commit statuses -> Read and write/);
});

test("a project that publishes with its own token is let through, and nothing is minted for it", async () => {
  // Issue #314: no App token is minted for such a project, so there is
  // no grant for this gate to read - and GitHub exposes a fine-grained
  // personal token's own scopes nowhere this could ask. Skipped rather
  // than guessed at; a token missing entirely is refused before any
  // worker starts, by publishToken's check() through Inspector.prepare().
  const recordHome = home();
  const project = githubProject();
  const { id: taskId } = registerTask(recordHome, "small change");
  const minter = fakeMinter({ granted: WITHOUT_STATUSES });
  writeFileSync(
    join(recordHome, "projects.toml"),
    `[projects.dayjob]\npath = "${project}"\ncheck = "./check.sh"\ngithubTokenVar = "DAYJOB_GITHUB_TOKEN"\n`
  );

  await requirePublishPermissions(recordHome, taskId, project, minter, { DAYJOB_GITHUB_TOKEN: "github_pat_fake" });

  assert.equal(minter.calls.length, 0);
  assert.deepEqual(readEvents(recordHome).filter((e) => e.name === "token-minted"), []);
});

// Issue #331: a project that publishes with the GitHub CLI's own login
// gets this gate back, by a different route - an OAuth login's write
// access to one repository IS readable (`permissions.push`), where a
// fine-grained token's own scopes are not. Driven with a real stand-in
// `gh` and a stand-in GitHub, so no test asks the machine running it for
// a login.

function ghHome(project: string): string {
  const recordHome = home();
  writeFileSync(
    join(recordHome, "projects.toml"),
    `[projects.dayjob]\npath = ${JSON.stringify(project)}\ncheck = "./check.sh"\ngithubToken = "gh"\n`
  );
  return recordHome;
}

/** A GitHub that answers one status and one body for the repository
 * read, and counts the calls. */
function stubRepoRead(status: number, body: string) {
  const calls: string[] = [];
  const fetchImpl: HttpFetch = async (url) => {
    calls.push(url);
    return { status, text: async () => body };
  };
  return { fetchImpl, calls };
}

test("a gh login that can push lets the task through, and mints nothing", async () => {
  const project = githubProject();
  const recordHome = ghHome(project);
  const { id: taskId } = registerTask(recordHome, "small change");
  const gh = fakeGh("printf 'gho_from_the_cli\\n'");
  const minter = fakeMinter({ granted: WITHOUT_STATUSES });
  const github = stubRepoRead(200, JSON.stringify({ permissions: { push: true } }));

  await requirePublishPermissions(recordHome, taskId, project, minter, {}, { env: gh.env, fetchImpl: github.fetchImpl });

  assert.deepEqual(github.calls, ["https://api.github.com/repos/acme/widgets"]);
  assert.equal(minter.calls.length, 0, "the App was asked for a token for a gh-login project");
  assert.deepEqual(readEvents(recordHome).filter((e) => e.name === "token-minted"), []);
});

test("a gh login that cannot push refuses at task start, naming the gh command that fixes it", async () => {
  const project = githubProject();
  const recordHome = ghHome(project);
  const { id: taskId } = registerTask(recordHome, "small change");
  const gh = fakeGh("printf 'gho_from_the_cli\\n'");
  const github = stubRepoRead(200, JSON.stringify({ permissions: { push: false } }));

  await assert.rejects(
    () =>
      requirePublishPermissions(recordHome, taskId, project, fakeMinter(), {}, { env: gh.env, fetchImpl: github.fetchImpl }),
    (err: unknown) =>
      err instanceof ForemanError &&
      err.code === "gh-login-unavailable" &&
      /cannot push to acme\/widgets/.test(err.message) &&
      /gh auth login --hostname github\.com/.test(err.message)
  );
});

test("a machine with no gh at all refuses at task start, without asking GitHub anything", async () => {
  const project = githubProject();
  const recordHome = ghHome(project);
  const { id: taskId } = registerTask(recordHome, "small change");
  const github = stubRepoRead(200, JSON.stringify({ permissions: { push: true } }));

  await assert.rejects(
    () =>
      requirePublishPermissions(recordHome, taskId, project, fakeMinter(), {}, { env: noGh(), fetchImpl: github.fetchImpl }),
    (err: unknown) => err instanceof ForemanError && err.code === "gh-login-unavailable" && /not installed/.test(err.message)
  );
  assert.deepEqual(github.calls, []);
});

test("fabrica do refuses a gh-login project at task start, with doctor's own words", async (t) => {
  // The whole wiring, with no seam passed in: `foreman.do` reaches the
  // real `ghAuthToken`, which spawns whatever `gh` is on PATH. A logged
  // out one, so nothing is asked of GitHub and no network is touched.
  const project = githubProject();
  const recordHome = ghHome(project);
  const gh = fakeGh("echo 'not logged in' >&2\nexit 4");
  const priorPath = process.env.PATH;
  process.env.PATH = `${gh.dir}${delimiter}${priorPath ?? ""}`;
  t.after(() => {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
  });
  const brain = fakeBrain();

  await assert.rejects(
    () => createForeman({ recordHome, minter: fakeMinter() }).do("small change", { project, brain }),
    (err: unknown) => err instanceof ForemanError && err.code === "gh-login-unavailable"
  );

  assert.equal(brain.calls, 0, "a worker ran on a task that could never be published");
  const events = readEvents(recordHome);
  assert.ok(!events.some((event) => event.name === "work-started"), "work started before the refusal");
  const failed = events.find((event) => event.name === "task-failed");
  assert.ok(failed !== undefined, "the refusal left no trace on the record");
  // The same sentence `fabrica doctor`'s project line prints, so the
  // Client never meets two accounts of one problem.
  assert.match(String((failed.details as { message?: unknown }).message), /not logged in to github\.com/);
  assert.match(String((failed.details as { message?: unknown }).message), /gh auth login --hostname github\.com/);
});

test("a question GitHub could not answer lets the task through, exactly as an unreachable App does", async () => {
  // Evidence versus the absence of it (this file's own header): refusing
  // on an unasked question would stop work on a correctly configured
  // project every time the machine is offline.
  const project = githubProject();
  const recordHome = ghHome(project);
  const { id: taskId } = registerTask(recordHome, "small change");
  const gh = fakeGh("printf 'gho_from_the_cli\\n'");
  const fetchImpl: HttpFetch = async () => {
    throw new Error("getaddrinfo ENOTFOUND api.github.com");
  };

  await requirePublishPermissions(recordHome, taskId, project, fakeMinter(), {}, { env: gh.env, fetchImpl });

  assert.ok(true, "nothing was thrown");
});

// Work mode (issue #316): a project Inspector posts no commit status
// for. Its handoff asks GitHub for no `statuses: write` at all, so this
// gate must check exactly that narrower set - otherwise it refuses every
// task on such a project over a permission nothing it does will use.

function noStampHome(project: string): string {
  const recordHome = home();
  writeFileSync(
    join(recordHome, "projects.toml"),
    `[projects.dayjob]\npath = ${JSON.stringify(project)}\ncheck = "bin/ci"\nnoStamp = true\n`
  );
  return recordHome;
}

test("a no-stamp project is let through on a grant with no statuses: write", async () => {
  const project = githubProject();
  const recordHome = noStampHome(project);
  const { id: taskId } = registerTask(recordHome, "small change");
  const minter = fakeMinter({ granted: WITHOUT_STATUSES });

  await requirePublishPermissions(recordHome, taskId, project, minter);

  // And the mint it took asked for the narrower set, not the wider one
  // with a missing permission waved through.
  assert.deepEqual(minter.calls[0].scope.permissions, { contents: "write", pull_requests: "write" });
});

test("a no-stamp project is still refused when it cannot push or open a pull request", async () => {
  const project = githubProject();
  const recordHome = noStampHome(project);
  const { id: taskId } = registerTask(recordHome, "small change");

  await assert.rejects(
    () =>
      requirePublishPermissions(recordHome, taskId, project, fakeMinter({ granted: { contents: "write" } })),
    (err: unknown) =>
      err instanceof ForemanError &&
      err.code === "publish-not-permitted" &&
      /pull_requests: write/.test(err.message)
  );
});

test("a project that says nothing about the stamp is still held to the full publishing set", async () => {
  const recordHome = home();
  const { id: taskId } = registerTask(recordHome, "small change");
  const minter = fakeMinter();

  await requirePublishPermissions(recordHome, taskId, githubProject(), minter);

  assert.deepEqual(minter.calls[0].scope.permissions, PUBLISH_PERMISSIONS);
});
