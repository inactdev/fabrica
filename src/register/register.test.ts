// `fabrica register` end to end, with real git throughout: a real
// `git worktree add`, a real commit, a real push to the fixture's own
// bare origin, a real teardown, a real projects.toml write. Only the
// four things a test machine genuinely may not have are faked - `gh`,
// the Docker daemon, the containerized check run, and `gh pr create` -
// via src/register/helpers/fake-register-tools.ts.
//
// The check "runs" by reading the check.sh register just wrote, so
// `--check "exit 3"` is genuinely red and `--check "exit 0"` genuinely
// green, without a container.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint, makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { loadConfig, projectsTomlPath } from "../config/index.ts";
import { RegisterError } from "./errors.ts";
import { registerProject } from "./register.ts";
import { CHECK_SCRIPT, INSPECTOR_CONFIG, RECORDED_CHECK, REGISTER_BRANCH } from "./origin.ts";
import { fakeRegisterTools } from "./helpers/fake-register-tools.ts";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-register-home-"));
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A fixture whose own .git/config carries a committer, since register
 * commits as the Client rather than overriding his identity. */
function project(opts: { inspector?: boolean; origin?: boolean } = {}): string {
  const dir = makeFixtureRepo("exit 0", opts);
  git(dir, ["config", "user.email", "client@example.test"]);
  git(dir, ["config", "user.name", "The Client"]);
  return dir;
}

function defaultBranchOf(dir: string): string {
  return git(dir, ["branch", "--show-current"]);
}

function originPath(dir: string): string {
  return git(dir, ["remote", "get-url", "origin"]);
}

function fileOnOriginBranch(dir: string, branch: string, path: string): string {
  return execFileSync("git", ["show", `${branch}:${path}`], {
    cwd: originPath(dir),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function originHasBranch(dir: string, branch: string): boolean {
  return git(dir, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]).length > 0;
}

function linkedWorktreeCount(dir: string): number {
  return git(dir, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree ")).length - 1;
}

// ---------------------------------------------------------------- full

test("register: writes the two files, runs the check in the image, pushes a branch, opens a PR, registers", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: false });
  const branch = defaultBranchOf(dir);
  const tools = fakeRegisterTools();

  const result = await registerProject(
    { recordHome, path: dir, check: "exit 0", image: "cimg/node:24.18.0", protectedPaths: ["*.test.ts"] },
    { tools }
  );

  assert.equal(result.kind, "full");
  assert.equal(result.defaultBranch, branch);
  assert.equal(result.branch, REGISTER_BRANCH);
  assert.equal(result.pullRequestUrl, "https://github.com/fake/repo/pull/1");
  assert.equal(result.check, RECORDED_CHECK);

  // The branch really is on origin, with both files on it.
  assert.equal(originHasBranch(dir, REGISTER_BRANCH), true);
  const config = JSON.parse(fileOnOriginBranch(dir, REGISTER_BRANCH, INSPECTOR_CONFIG));
  assert.equal(config.check, RECORDED_CHECK);
  assert.equal(config.image, "cimg/node:24.18.0");
  assert.deepEqual(config.protectedPaths, [CHECK_SCRIPT, INSPECTOR_CONFIG, "*.test.ts"]);
  assert.ok(fileOnOriginBranch(dir, REGISTER_BRANCH, CHECK_SCRIPT).endsWith("exit 0\n"));

  // projects.toml gained exactly the entry it reports.
  assert.equal(loadConfig(recordHome).projects[result.name].path, dir);
  assert.equal(loadConfig(recordHome).projects[result.name].check, RECORDED_CHECK);
  assert.ok(readFileSync(projectsTomlPath(recordHome), "utf8").includes(result.tomlEntry.trim()));
});

test("register: the name defaults to origin's repository name, and --name overrides it", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: false });
  const expected = originPath(dir).split("/").pop();

  const result = await registerProject(
    { recordHome, path: dir, check: "exit 0", image: "node:24" },
    { tools: fakeRegisterTools() }
  );
  assert.equal(result.name, expected);

  const other = project({ inspector: false });
  const named = await registerProject(
    { recordHome, path: other, check: "exit 0", image: "node:24", name: "spending-app" },
    { tools: fakeRegisterTools() }
  );
  assert.equal(named.name, "spending-app");
  assert.ok(Object.hasOwn(loadConfig(recordHome).projects, "spending-app"));
});

// The same property CONTRACT rule 1 holds a ProductionLine to: the
// Client's own checkout is only ever read.
test("register: the Client's own checkout is byte-for-byte untouched, and no worktree is left behind", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: false });
  const before = fingerprint(dir);
  const head = git(dir, ["rev-parse", "HEAD"]);
  const checkedOut = defaultBranchOf(dir);

  await registerProject(
    { recordHome, path: dir, check: "exit 0", image: "node:24" },
    { tools: fakeRegisterTools() }
  );

  assert.equal(fingerprint(dir), before, "register must never write into the Client's working tree");
  assert.equal(git(dir, ["rev-parse", "HEAD"]), head, "his HEAD must not move");
  assert.equal(defaultBranchOf(dir), checkedOut, "his checked-out branch must not change");
  assert.equal(linkedWorktreeCount(dir), 0, "the temporary worktree must be gone");
});

test("register: the check runs inside --image, against the temporary worktree - never the project itself", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: false });
  const tools = fakeRegisterTools();

  await registerProject({ recordHome, path: dir, check: "exit 0", image: "cimg/node:24.18.0" }, { tools });

  assert.equal(tools.checkCalls.length, 1);
  const [call] = tools.checkCalls;
  assert.equal(call.image, "cimg/node:24.18.0");
  assert.equal(call.command, RECORDED_CHECK);
  assert.notEqual(call.workdir, dir);
  assert.ok(!call.workdir.startsWith(`${dir}/`), "the check must not run against the Client's own checkout");
});

test("register: the pull request goes from fabrica/register into origin's default branch", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: false });
  const tools = fakeRegisterTools();

  const result = await registerProject(
    { recordHome, path: dir, check: "npm test", image: "node:24" },
    { tools }
  );

  assert.equal(tools.pullRequestCalls.length, 1);
  const [pr] = tools.pullRequestCalls;
  assert.equal(pr.base, result.defaultBranch);
  assert.equal(pr.head, REGISTER_BRANCH);
  assert.ok(pr.title.includes(result.name));
  assert.ok(pr.body.includes("npm test"), "the body must name the command the Client gave");
  assert.ok(pr.body.includes("node:24"), "and the image it was proven in");
});

// ------------------------------------------------------------- refusals

test("register: a failing check refuses - nothing pushed, no PR, nothing registered, nothing left behind", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: false });
  const tools = fakeRegisterTools();
  const before = fingerprint(dir);

  await assert.rejects(
    registerProject({ recordHome, path: dir, check: "exit 3", image: "node:24" }, { tools }),
    (err: unknown) =>
      err instanceof RegisterError && err.code === "check-failed" && err.message.includes("exit 3")
  );

  assert.equal(originHasBranch(dir, REGISTER_BRANCH), false);
  assert.equal(tools.pullRequestCalls.length, 0);
  assert.equal(existsSync(projectsTomlPath(recordHome)), false);
  assert.equal(linkedWorktreeCount(dir), 0);
  assert.equal(fingerprint(dir), before);
});

// A retry with a corrected --check must not be blocked by the wreckage of
// the attempt before it, so an unpushed branch is cleaned up too.
test("register: after a failed check, a corrected retry succeeds", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: false });

  await assert.rejects(
    registerProject({ recordHome, path: dir, check: "exit 3", image: "node:24" }, { tools: fakeRegisterTools() })
  );
  assert.equal(git(dir, ["branch", "--list", REGISTER_BRANCH]), "", "the unpushed branch must be gone");

  const result = await registerProject(
    { recordHome, path: dir, check: "exit 0", image: "node:24" },
    { tools: fakeRegisterTools() }
  );
  assert.equal(result.kind, "full");
});

test("register: a box that could not run the check at all is never read as a red check", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: false });
  const tools = fakeRegisterTools({ check: () => ({ ran: false, reason: "no such image" }) });

  await assert.rejects(
    registerProject({ recordHome, path: dir, check: "exit 0", image: "nope:1" }, { tools }),
    (err: unknown) =>
      err instanceof RegisterError && err.code === "check-not-run" && err.message.includes("no such image")
  );
  assert.equal(originHasBranch(dir, REGISTER_BRANCH), false);
});

test("register: <path> must be an existing git repository's root", async () => {
  const recordHome = tempHome();
  const notARepo = mkdtempSync(join(tmpdir(), "fabrica-register-plain-"));

  await assert.rejects(
    registerProject({ recordHome, path: notARepo, check: "exit 0", image: "node:24" }, { tools: fakeRegisterTools() }),
    (err: unknown) => err instanceof RegisterError && err.code === "not-a-repo"
  );
});

test("register: a repository with no origin refuses, since a task's branch is cut from origin", async () => {
  const recordHome = tempHome();

  await assert.rejects(
    registerProject(
      { recordHome, path: project({ inspector: false, origin: false }), check: "exit 0", image: "node:24" },
      { tools: fakeRegisterTools() }
    ),
    (err: unknown) => err instanceof RegisterError && err.code === "no-origin" && err.message.includes("git remote add origin")
  );
});

test("register: gh missing or logged out refuses up front, naming gh auth login", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: false });
  const tools = fakeRegisterTools({ gh: { ok: false, detail: "gh is not on PATH", fix: "run `gh auth login`" } });

  await assert.rejects(
    registerProject({ recordHome, path: dir, check: "exit 0", image: "node:24" }, { tools }),
    (err: unknown) =>
      err instanceof RegisterError &&
      err.code === "gh-not-ready" &&
      err.message.includes("gh auth login") &&
      err.message.includes("Nothing was changed")
  );
  assert.equal(tools.checkCalls.length, 0, "nothing should have been attempted");
  assert.equal(linkedWorktreeCount(dir), 0);
});

test("register: an unreachable Docker daemon refuses before any worktree is created", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: false });
  const tools = fakeRegisterTools({ docker: { ok: false, detail: "`docker info` failed", fix: "start Docker" } });

  await assert.rejects(
    registerProject({ recordHome, path: dir, check: "exit 0", image: "node:24" }, { tools }),
    (err: unknown) => err instanceof RegisterError && err.code === "docker-not-ready"
  );
  assert.equal(linkedWorktreeCount(dir), 0);
});

// Both missing: the message must name gh, since that is the first thing
// checked - a refusal that listed every problem at once would be a
// different design, and this one is deliberately one-at-a-time.
test("register: prerequisites are checked in order - gh before Docker", async () => {
  const recordHome = tempHome();
  const tools = fakeRegisterTools({
    gh: { ok: false, detail: "gh is not on PATH" },
    docker: { ok: false, detail: "`docker info` failed" },
  });

  await assert.rejects(
    registerProject(
      { recordHome, path: project({ inspector: false }), check: "exit 0", image: "node:24" },
      { tools }
    ),
    (err: unknown) => err instanceof RegisterError && err.code === "gh-not-ready"
  );
});

test("register: a fabrica/register branch already on origin refuses - never overwritten, never force-pushed", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: false });
  git(dir, ["branch", REGISTER_BRANCH]);
  git(dir, ["push", "-q", "origin", REGISTER_BRANCH]);
  const originalTip = git(dir, ["rev-parse", REGISTER_BRANCH]);

  await assert.rejects(
    registerProject({ recordHome, path: dir, check: "exit 0", image: "node:24" }, { tools: fakeRegisterTools() }),
    (err: unknown) =>
      err instanceof RegisterError && err.code === "branch-exists" && err.message.includes("origin already has")
  );
  assert.equal(git(dir, ["rev-parse", REGISTER_BRANCH]), originalTip, "the existing branch must be untouched");
});

test("register: a leftover local fabrica/register branch refuses, saying how to clear it", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: false });
  git(dir, ["branch", REGISTER_BRANCH]);

  await assert.rejects(
    registerProject({ recordHome, path: dir, check: "exit 0", image: "node:24" }, { tools: fakeRegisterTools() }),
    (err: unknown) =>
      err instanceof RegisterError && err.code === "branch-exists" && err.message.includes("branch -D")
  );
});

test("register: a project already in projects.toml refuses, naming what is already there", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: false });

  await registerProject(
    { recordHome, path: dir, check: "exit 0", image: "node:24", name: "taken" },
    { tools: fakeRegisterTools() }
  );
  // Clear the branch so the refusal below is about the registration, not
  // about the branch the first run left on origin.
  const other = project({ inspector: false });

  await assert.rejects(
    registerProject(
      { recordHome, path: other, check: "exit 0", image: "node:24", name: "taken" },
      { tools: fakeRegisterTools() }
    ),
    (err: unknown) =>
      err instanceof RegisterError && err.code === "already-registered" && err.message.includes("[projects.taken]")
  );
});

test("register: the same repository under a second name refuses too", async () => {
  const recordHome = tempHome();
  const dir = project();

  await registerProject({ recordHome, path: dir, name: "first" }, { tools: fakeRegisterTools() });

  await assert.rejects(
    registerProject({ recordHome, path: dir, name: "second" }, { tools: fakeRegisterTools() }),
    (err: unknown) =>
      err instanceof RegisterError &&
      err.code === "already-registered" &&
      err.message.includes("[projects.first]")
  );
});

test("register: a name that cannot be a projects.toml table refuses, pointing at --name", async () => {
  const recordHome = tempHome();

  await assert.rejects(
    registerProject(
      { recordHome, path: project({ inspector: false }), check: "exit 0", image: "node:24", name: "my app" },
      { tools: fakeRegisterTools() }
    ),
    (err: unknown) => err instanceof RegisterError && err.code === "bad-name" && err.message.includes("--name")
  );
});

test("register: a repository needing setup refuses without --check and --image, naming both", async () => {
  const recordHome = tempHome();

  await assert.rejects(
    registerProject({ recordHome, path: project({ inspector: false }) }, { tools: fakeRegisterTools() }),
    (err: unknown) =>
      err instanceof RegisterError &&
      err.code === "missing-check-or-image" &&
      err.message.includes("--check") &&
      err.message.includes("--image")
  );
});

// gh's documented sharp edge: it can exit non-zero having already
// printed a real pull request URL. The opposite - no URL at all - is a
// refusal, and it must say that the branch IS on origin, since it is.
test("register: gh opening no pull request refuses, but says the branch is already pushed", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: false });
  const tools = fakeRegisterTools({ pullRequest: { url: null, message: "gh: could not create pull request" } });

  await assert.rejects(
    registerProject({ recordHome, path: dir, check: "exit 0", image: "node:24" }, { tools }),
    (err: unknown) =>
      err instanceof RegisterError &&
      err.code === "pull-request-failed" &&
      err.message.includes("is pushed to origin")
  );
  assert.equal(originHasBranch(dir, REGISTER_BRANCH), true);
  assert.equal(existsSync(projectsTomlPath(recordHome)), false, "nothing is registered when no PR was opened");
  // The pushed branch is deliberately left alone - it is on origin now,
  // and deleting a branch the Client may want is not this command's call.
  assert.equal(linkedWorktreeCount(dir), 0, "but the temporary worktree is still cleaned up");
});

// ------------------------------------------------------- shortcut case

test("register: a repository already carrying .inspector.json on origin only gains a projects.toml entry", async () => {
  const recordHome = tempHome();
  const dir = project();
  const tools = fakeRegisterTools();
  const before = fingerprint(dir);

  const result = await registerProject({ recordHome, path: dir }, { tools });

  assert.equal(result.kind, "registry-only");
  assert.equal(result.check, RECORDED_CHECK);
  assert.equal(result.branch, undefined);
  assert.equal(tools.checkCalls.length, 0, "nothing to prove - the repository is already set up");
  assert.equal(tools.pullRequestCalls.length, 0);
  assert.equal(originHasBranch(dir, REGISTER_BRANCH), false);
  assert.equal(linkedWorktreeCount(dir), 0);
  assert.equal(fingerprint(dir), before);
  assert.equal(loadConfig(recordHome).projects[result.name].check, RECORDED_CHECK);
});

test("register: the shortcut case needs neither --check nor --image, and ignores a --check given anyway", async () => {
  const recordHome = tempHome();
  const dir = project();

  const result = await registerProject(
    { recordHome, path: dir, check: "something else entirely", image: "node:24" },
    { tools: fakeRegisterTools() }
  );

  assert.equal(result.kind, "registry-only");
  assert.equal(result.check, RECORDED_CHECK, "the repository's own check.sh is what Inspector runs");
});

test("register: .inspector.json on origin but no check.sh refuses, saying exactly that", async () => {
  const recordHome = tempHome();
  const dir = project();
  git(dir, ["rm", "-q", CHECK_SCRIPT]);
  git(dir, ["commit", "-qm", "drop check.sh"]);
  git(dir, ["push", "-q", "origin", defaultBranchOf(dir)]);

  await assert.rejects(
    registerProject({ recordHome, path: dir }, { tools: fakeRegisterTools() }),
    (err: unknown) =>
      err instanceof RegisterError &&
      err.code === "no-check-script" &&
      err.message.includes(INSPECTOR_CONFIG) &&
      err.message.includes(CHECK_SCRIPT)
  );
  assert.equal(existsSync(projectsTomlPath(recordHome)), false);
});

// Which branch is origin's default is read from the remote, never
// assumed to be "master" - the same property src/line/cut.ts has.
test("register: origin's default branch is whatever the remote says, not an assumed name", async () => {
  const recordHome = tempHome();
  const dir = mkdtempSync(join(tmpdir(), "fabrica-register-trunk-"));
  writeFileSync(join(dir, "app.txt"), "hello\n");
  execFileSync("git", ["init", "-q", "-b", "trunk", dir]);
  git(dir, ["config", "user.email", "client@example.test"]);
  git(dir, ["config", "user.name", "The Client"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "init"]);
  const bare = mkdtempSync(join(tmpdir(), "fabrica-register-trunk-origin-"));
  execFileSync("git", ["init", "-q", "--bare", bare]);
  git(dir, ["remote", "add", "origin", bare]);
  git(dir, ["push", "-q", "origin", "trunk"]);
  execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/trunk"], { cwd: bare });

  const result = await registerProject(
    { recordHome, path: dir, check: "exit 0", image: "node:24" },
    { tools: fakeRegisterTools() }
  );

  assert.equal(result.defaultBranch, "trunk");
  assert.equal(result.pullRequestUrl, "https://github.com/fake/repo/pull/1");
});
