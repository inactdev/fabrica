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
import { RegisterError, RegisterProposalError } from "./errors.ts";
import { registerProject } from "./register.ts";
import { CHECK_SCRIPT, INSPECTOR_CONFIG, RECORDED_CHECK, REGISTER_BRANCH } from "./origin.ts";
import { DOCKERFILE_INSPECTOR } from "./dockerfile.ts";
import { fakeRegisterTools } from "./helpers/fake-register-tools.ts";
import { writeRailsFixture } from "./helpers/rails-fixture.ts";

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

test("register: writes the three files, runs the check in the image, pushes a branch, opens a PR, registers", async () => {
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
  assert.equal(result.dockerfile, "written");

  // The branch really is on origin, with all three files on it.
  assert.equal(originHasBranch(dir, REGISTER_BRANCH), true);
  const config = JSON.parse(fileOnOriginBranch(dir, REGISTER_BRANCH, INSPECTOR_CONFIG));
  assert.equal(config.check, RECORDED_CHECK);
  assert.deepEqual(config.protectedPaths, [CHECK_SCRIPT, INSPECTOR_CONFIG, DOCKERFILE_INSPECTOR, "*.test.ts"]);
  assert.ok(fileOnOriginBranch(dir, REGISTER_BRANCH, CHECK_SCRIPT).endsWith("exit 0\n"));
  // The image is on the Dockerfile's FROM line now, not in the config:
  // inspector#47 retired that key, with any value.
  assert.equal(Object.hasOwn(config, "image"), false, "the image key is retired");
  assert.equal(Object.hasOwn(config, "network"), false, "and so is the network key");
  assert.ok(
    fileOnOriginBranch(dir, REGISTER_BRANCH, DOCKERFILE_INSPECTOR).includes("FROM cimg/node:24.18.0"),
    "the check box is built from Dockerfile.inspector"
  );

  // projects.toml gained exactly the entry it reports.
  assert.equal(loadConfig(recordHome).projects[result.name].path, dir);
  assert.equal(loadConfig(recordHome).projects[result.name].check, RECORDED_CHECK);
  assert.ok(readFileSync(projectsTomlPath(recordHome), "utf8").includes(result.tomlEntry.trim()));
});

// --timeout describes the box Inspector will use later, so it has to
// reach the committed file - and nothing else may appear in it when it is
// left out.
test("register: --timeout lands in the pushed .inspector.json, and nothing does without it", async () => {
  const recordHome = tempHome();
  const withFlags = project({ inspector: false });
  const tools = fakeRegisterTools();

  await registerProject(
    {
      recordHome,
      path: withFlags,
      check: "exit 0",
      image: "cimg/node:24.18.0",
      timeoutSeconds: 1200,
      name: "with-flags",
    },
    { tools }
  );

  const config = JSON.parse(fileOnOriginBranch(withFlags, REGISTER_BRANCH, INSPECTOR_CONFIG));
  assert.equal(config.timeoutSeconds, 1200);
  const [pr] = tools.pullRequestCalls;
  assert.ok(pr.body.includes("1200 seconds"), "the reviewer should read it, not only diff it");

  const plain = project({ inspector: false });
  await registerProject(
    { recordHome, path: plain, check: "exit 0", image: "cimg/node:24.18.0", name: "plain" },
    { tools: fakeRegisterTools() }
  );
  const plainConfig = JSON.parse(fileOnOriginBranch(plain, REGISTER_BRANCH, INSPECTOR_CONFIG));
  assert.equal(Object.hasOwn(plainConfig, "timeoutSeconds"), false, "off is the absence of the key");
});

// Issue #303: the check box has no network, so a project's dependencies
// are installed in the Dockerfile at build time - and check.sh gets the
// other half of that mechanism, since a node_modules nothing links in is
// a node_modules that is never there.
test("register: a package-lock.json project gets an install step and a check.sh that links it in", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: false });
  writeFileSync(join(dir, "package-lock.json"), "{}\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "add lockfile"]);
  git(dir, ["push", "-q", "origin", defaultBranchOf(dir)]);
  const tools = fakeRegisterTools();

  await registerProject({ recordHome, path: dir, check: "exit 0", image: "cimg/node:24.18.0" }, { tools });

  const dockerfile = fileOnOriginBranch(dir, REGISTER_BRANCH, DOCKERFILE_INSPECTOR);
  assert.ok(dockerfile.includes("npm ci"), dockerfile);
  assert.ok(dockerfile.includes("/deps"), dockerfile);
  const script = fileOnOriginBranch(dir, REGISTER_BRANCH, CHECK_SCRIPT);
  assert.ok(script.includes("ln -s /deps/node_modules node_modules"), script);
  const [pr] = tools.pullRequestCalls;
  assert.ok(pr.body.includes("npm ci"), "the reviewer should read what the image bakes");
});

// Issue #324, on the route that commits into the repository: the shape
// is a fact about the lockfile, so the servers and the gems reach the
// committed files even though the command here is the Client's own
// --check rather than a derived one.
test("register: a Rails project's committed files carry its servers, its gems and the suite", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: false });
  writeRailsFixture(dir);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "rails app"]);
  git(dir, ["push", "-q", "origin", defaultBranchOf(dir)]);
  const tools = fakeRegisterTools();

  await registerProject(
    { recordHome, path: dir, check: "bundle exec rspec", image: "ruby:3.3.4" },
    { tools }
  );

  const dockerfile = fileOnOriginBranch(dir, REGISTER_BRANCH, DOCKERFILE_INSPECTOR);
  assert.ok(dockerfile.includes("FROM ruby:3.3.4"), dockerfile);
  assert.ok(dockerfile.includes("postgresql libpq-dev redis-server"), dockerfile);
  assert.ok(dockerfile.includes("bundle install"), dockerfile);

  // The Client's own command, with the preamble the shape needs around
  // it - nothing about --check is paraphrased.
  const script = fileOnOriginBranch(dir, REGISTER_BRANCH, CHECK_SCRIPT);
  assert.ok(script.includes("service postgresql start"), script);
  assert.ok(script.includes("bin/rails db:test:prepare"), script);
  assert.ok(script.trimEnd().endsWith("bundle exec rspec"), script);

  const [pr] = tools.pullRequestCalls;
  assert.ok(pr.body.includes("PostgreSQL and Redis are installed in"), pr.body);
});

// Fabrica's containment runs every container as the host user, and
// starting those servers needs root - so this one route cannot prove
// this one check shape, and the refusal has to say which of the two it
// is rather than leaving a permission error to be puzzled over.
test("register: a failing check on a project with servers says why this route cannot prove it", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: false });
  writeRailsFixture(dir);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "rails app"]);
  git(dir, ["push", "-q", "origin", defaultBranchOf(dir)]);
  const tools = fakeRegisterTools({
    check: () => ({ ran: true, exitCode: 1, output: "service postgresql start: Permission denied" }),
  });

  await assert.rejects(
    registerProject({ recordHome, path: dir, check: "bundle exec rspec", image: "ruby:3.3.4" }, { tools }),
    (err: unknown) => {
      assert.ok(err instanceof RegisterError);
      assert.equal(err.code, "check-failed");
      assert.match(err.message, /PostgreSQL and Redis inside the box, which needs root/);
      assert.match(err.message, /--terms/);
      return true;
    }
  );
  assert.equal(originHasBranch(dir, REGISTER_BRANCH), false, "and still nothing was pushed");
});

// Nothing is invented for a shape it does not recognize: the file says
// so where the install step would have gone.
test("register: a project with no lockfile gets a Dockerfile that says so, not a guessed install", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: false });

  await registerProject(
    { recordHome, path: dir, check: "exit 0", image: "node:24" },
    { tools: fakeRegisterTools() }
  );

  const dockerfile = fileOnOriginBranch(dir, REGISTER_BRANCH, DOCKERFILE_INSPECTOR);
  assert.ok(!dockerfile.includes("RUN "), dockerfile);
  assert.ok(dockerfile.includes("Add what ./check.sh needs here"), dockerfile);
});

// Clarification 2 (Client ruling): register never overwrites a committed
// file. A repository that already has a Dockerfile.inspector keeps it,
// exactly as it is, and is told so.
test("register: a committed Dockerfile.inspector is left untouched, and said so", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: false });
  const theirs = "FROM their/own:image\n# hand-written, and not ours to rewrite\n";
  writeFileSync(join(dir, DOCKERFILE_INSPECTOR), theirs);
  // A lockfile too, so check.sh still gets its link preamble from a file
  // register did not write - the one thing the reviewer has to check the
  // two halves agree on.
  writeFileSync(join(dir, "package-lock.json"), "{}\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "add our own check image"]);
  git(dir, ["push", "-q", "origin", defaultBranchOf(dir)]);
  const tools = fakeRegisterTools();
  const notes: string[] = [];

  const result = await registerProject(
    { recordHome, path: dir, check: "exit 0", image: "node:24" },
    { tools, notify: (line) => notes.push(line) }
  );

  assert.equal(result.dockerfile, "already-committed");
  assert.equal(fileOnOriginBranch(dir, REGISTER_BRANCH, DOCKERFILE_INSPECTOR), theirs, "byte for byte");
  assert.ok(notes.some((line) => line.includes("leaving it exactly as it is")), notes.join("\n"));
  const [pr] = tools.pullRequestCalls;
  assert.ok(pr.body.includes("never overwrites a committed file"), pr.body);
  // check.sh expects /deps/node_modules, and their file may put the
  // dependencies somewhere else entirely - the reviewer is told to check
  // that, rather than finding out from a red first task.
  assert.ok(pr.body.includes("/deps/node_modules"), pr.body);
  assert.ok(pr.body.includes("has no network to install them at check time"), pr.body);
});

// A check that installs its own dependencies cannot, in a box with no
// network - named before the merge rather than left to a red first task.
test("register: a check command that fetches is warned about, on the result and in the pull request", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: false });
  writeFileSync(join(dir, "package-lock.json"), "{}\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "add lockfile"]);
  git(dir, ["push", "-q", "origin", defaultBranchOf(dir)]);
  const tools = fakeRegisterTools({ check: () => ({ ran: true, exitCode: 0, output: "" }) });

  const result = await registerProject(
    { recordHome, path: dir, check: "npm ci && npm test", image: "cimg/node:24.18.0" },
    { tools }
  );

  assert.equal(result.warnings?.length, 1, JSON.stringify(result.warnings));
  assert.ok(result.warnings?.[0].includes("`npm ci`"), result.warnings?.[0]);
  const [pr] = tools.pullRequestCalls;
  assert.ok(pr.body.includes("Worth a look before merging"), pr.body);
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

// Issue #114: a repository that needs setting up, with nothing said
// about how, gets a proposed .inspector.json rather than a bare refusal -
// and the proposal is still a refusal in every other respect. Nothing is
// written, nothing is pushed, nothing is registered, and the Client's own
// checkout comes out byte for byte identical.
test("register: a repository needing setup proposes an .inspector.json, having created nothing", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: false });
  const before = fingerprint(dir);

  await assert.rejects(
    registerProject({ recordHome, path: dir }, { tools: fakeRegisterTools() }),
    (err: unknown) => {
      assert.ok(err instanceof RegisterProposalError, `${err}`);
      assert.equal(err.code, "proposed");
      // The fixture commits a check.sh, so that is the check, and the
      // one path the proposal protects.
      const config = JSON.parse(err.proposal.json) as Record<string, unknown>;
      assert.equal(config.check, RECORDED_CHECK);
      assert.deepEqual(config.protectedPaths, [CHECK_SCRIPT]);
      // The other way out is still named, since it is still there.
      assert.ok(err.message.includes("--check"), err.message);
      assert.ok(err.message.includes("--image"), err.message);
      return true;
    }
  );

  assert.equal(existsSync(projectsTomlPath(recordHome)), false);
  assert.equal(originHasBranch(dir, REGISTER_BRANCH), false);
  assert.equal(linkedWorktreeCount(dir), 0);
  assert.equal(fingerprint(dir), before, "the Client's own checkout is only ever read");
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
