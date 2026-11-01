// `fabrica register --terms <folder>` end to end: a work-mode project,
// whose terms cannot be committed to its own repository at all.
//
// Real git throughout, like register.test.ts - a real fixture with its
// own bare origin, real reads off origin's default branch, real files
// written into a real throwaway folder, a real projects.toml write. The
// four outside-this-machine things are still faked, and every test here
// asserts they were never reached: this route pushes nothing and opens
// nothing, so `gh`, the Docker daemon, the container and `gh pr create`
// have no part in it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fingerprint, makeFixtureRepo, pushToOrigin } from "../../contract/helpers/fixture.ts";
import { loadConfig, projectsTomlPath } from "../config/index.ts";
import { RegisterError } from "./errors.ts";
import { registerProject } from "./register.ts";
import { CHECK_SCRIPT, INSPECTOR_CONFIG, RECORDED_CHECK, REGISTER_BRANCH } from "./origin.ts";
import { DOCKERFILE_INSPECTOR } from "./dockerfile.ts";
import { fakeRegisterTools } from "./helpers/fake-register-tools.ts";
import { railsFixtureFiles } from "./helpers/rails-fixture.ts";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-terms-home-"));
}

function termsFolder(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-terms-"));
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A fixture with a committer of its own, like register.test.ts's. */
function project(opts: { inspector?: boolean } = {}): string {
  const dir = makeFixtureRepo("exit 0", { inspector: false, ...opts });
  git(dir, ["config", "user.email", "client@example.test"]);
  git(dir, ["config", "user.name", "The Client"]);
  return dir;
}

/** Commits and pushes, so a later read off origin's default branch sees
 * it - the ref every signal in this module is read from. A name may be a
 * nested path (`bin/rails`), whose directory is created here. */
function commit(dir: string, files: Record<string, string>): void {
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), contents);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "fixture"]);
  pushToOrigin(dir);
}

function dropCheckScript(dir: string): void {
  git(dir, ["rm", "-q", CHECK_SCRIPT]);
  git(dir, ["commit", "-qm", "drop check.sh"]);
  pushToOrigin(dir);
}

function originHasBranch(dir: string, branch: string): boolean {
  return git(dir, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]).length > 0;
}

function linkedWorktreeCount(dir: string): number {
  return git(dir, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree ")).length - 1;
}

// ------------------------------------------------------------ the route

test("register --terms: writes the three files into the folder, and touches the repository not at all", async () => {
  const recordHome = tempHome();
  const dir = project();
  dropCheckScript(dir);
  commit(dir, { "package.json": JSON.stringify({ scripts: { test: "node --test" } }) });
  const terms = termsFolder();
  const before = fingerprint(dir);
  const tools = fakeRegisterTools();

  const result = await registerProject({ recordHome, path: dir, terms }, { tools });

  assert.equal(result.kind, "terms");
  assert.equal(result.terms, terms);
  assert.deepEqual(
    (result.termsFiles ?? []).map((file) => [file.file, file.outcome]),
    [
      [INSPECTOR_CONFIG, "written"],
      [CHECK_SCRIPT, "written"],
      [DOCKERFILE_INSPECTOR, "written"],
    ]
  );
  for (const file of [INSPECTOR_CONFIG, CHECK_SCRIPT, DOCKERFILE_INSPECTOR]) {
    assert.equal(existsSync(join(terms, file)), true, file);
    assert.equal(existsSync(join(dir, file)), false, `${file} must never land in the repository`);
  }

  // Nothing about the repository moved: not its files, not a branch,
  // not a worktree - and none of the four outside things was reached.
  assert.equal(fingerprint(dir), before, "the Client's own checkout is only ever read");
  assert.equal(originHasBranch(dir, REGISTER_BRANCH), false);
  assert.equal(linkedWorktreeCount(dir), 0);
  assert.equal(tools.checkCalls.length, 0, "this route proves nothing, and must not pretend to");
  assert.equal(tools.pullRequestCalls.length, 0);
});

// One source of truth for the check: the printed proposal may name an
// indirect command, because it writes no script for it to live in. This
// route writes one, so the command goes inside it and the config names
// the script.
test("register --terms: the config names ./check.sh and check.sh holds the derived command", async () => {
  const recordHome = tempHome();
  const dir = project();
  dropCheckScript(dir);
  commit(dir, { "package.json": JSON.stringify({ scripts: { test: "node --test" } }) });
  const terms = termsFolder();

  const result = await registerProject({ recordHome, path: dir, terms }, { tools: fakeRegisterTools() });

  const config = JSON.parse(readFileSync(join(terms, INSPECTOR_CONFIG), "utf8")) as Record<string, unknown>;
  assert.equal(config.check, RECORDED_CHECK);
  assert.match(readFileSync(join(terms, CHECK_SCRIPT), "utf8"), /^npm test$/m);
  assert.equal(result.check, RECORDED_CHECK, "and projects.toml records the same one command");
  // Executable, like the one the repository route writes - Inspector and
  // a worker's own box both run it as a program.
  assert.equal(statSync(join(terms, CHECK_SCRIPT)).mode & 0o111, 0o111);
});

// The repository's own check.sh is the file `./check.sh` names, so a
// second copy in the terms folder would be a silent fork of it. Not
// written, and said out loud.
test("register --terms: a repository carrying its own check.sh keeps it, and no second one is written", async () => {
  const recordHome = tempHome();
  const dir = project();
  const terms = termsFolder();

  const result = await registerProject({ recordHome, path: dir, terms }, { tools: fakeRegisterTools() });

  const check = (result.termsFiles ?? []).find((file) => file.file === CHECK_SCRIPT);
  assert.equal(check?.outcome, "repository-has-its-own");
  assert.match(check?.detail ?? "", /already carries its own/);
  assert.equal(existsSync(join(terms, CHECK_SCRIPT)), false);
  assert.equal(existsSync(join(terms, INSPECTOR_CONFIG)), true, "the other two are still written");
  assert.equal(existsSync(join(terms, DOCKERFILE_INSPECTOR)), true);
});

// A stub that exited 0 would make every task on the project green for
// free, which is the one outcome this must never produce.
test("register --terms: a repository naming no command at all gets a check.sh that fails until written", async () => {
  const recordHome = tempHome();
  const dir = project();
  dropCheckScript(dir);
  const terms = termsFolder();

  await registerProject({ recordHome, path: dir, terms }, { tools: fakeRegisterTools() });

  const script = readFileSync(join(terms, CHECK_SCRIPT), "utf8");
  assert.match(script, /REPLACE-ME-with-/, "it carries the same marker every unfilled value does");
  assert.match(script, /^exit 1$/m);
  assert.doesNotMatch(script, /^exit 0$/m);
});

// Issue #303's /deps mechanism reaches this route too: the check box has
// no network, so a node project's dependencies are baked into the image
// and check.sh has to link them into the checkout.
test("register --terms: a package-lock.json project's check.sh links /deps/node_modules in", async () => {
  const recordHome = tempHome();
  const dir = project();
  dropCheckScript(dir);
  commit(dir, {
    "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
    "package-lock.json": JSON.stringify({ lockfileVersion: 3 }),
  });
  const terms = termsFolder();

  await registerProject({ recordHome, path: dir, terms }, { tools: fakeRegisterTools() });

  assert.match(readFileSync(join(terms, CHECK_SCRIPT), "utf8"), /ln -s \/deps\/node_modules node_modules/);
  assert.match(readFileSync(join(terms, DOCKERFILE_INSPECTOR), "utf8"), /npm ci/);
});

// Issue #324, end to end on the route a day job's repository actually
// takes: a Rails-shaped repository, read off origin's default branch,
// and the three files it derives - with the repository itself untouched.
test("register --terms: a Rails repository gets its servers, its gems and a longer timeout", async () => {
  const recordHome = tempHome();
  const dir = project();
  dropCheckScript(dir);
  commit(dir, railsFixtureFiles());
  const terms = termsFolder();
  const before = fingerprint(dir);

  const result = await registerProject({ recordHome, path: dir, terms }, { tools: fakeRegisterTools() });

  // .inspector.json: the usual, with the longer timeout (Client ruling,
  // 30 minutes) and check.sh as the one protected path.
  const config = JSON.parse(readFileSync(join(terms, INSPECTOR_CONFIG), "utf8")) as Record<string, unknown>;
  assert.equal(config.check, RECORDED_CHECK);
  assert.equal(config.timeoutSeconds, 1800);
  assert.deepEqual(config.protectedPaths, [CHECK_SCRIPT]);

  // check.sh: both servers started inside the box, waited for, the test
  // database created, the suite run, both stopped again.
  const script = readFileSync(join(terms, CHECK_SCRIPT), "utf8");
  assert.match(script, /^service postgresql start$/m);
  assert.match(script, /^wait_for PostgreSQL pg_isready -q$/m);
  assert.match(script, /^redis-server --daemonize yes --save ''$/m);
  assert.match(script, /^bin\/rails db:test:prepare$/m);
  assert.match(script, /^bundle exec rspec$/m);
  assert.match(script, /^trap stop_services EXIT$/m);
  assert.equal(statSync(join(terms, CHECK_SCRIPT)).mode & 0o111, 0o111);

  // Dockerfile.inspector: the official Ruby image for the pinned
  // version, the servers' packages, the gems at build time.
  const dockerfile = readFileSync(join(terms, DOCKERFILE_INSPECTOR), "utf8");
  assert.match(dockerfile, /^FROM ruby:3\.3\.4$/m);
  assert.match(dockerfile, /postgresql libpq-dev redis-server/);
  assert.match(dockerfile, /^RUN cd \/deps && bundle install$/m);

  // ...and none of it touched the repository, exactly as on every other
  // --terms run.
  assert.equal(fingerprint(dir), before, "the Client's own checkout is only ever read");
  for (const file of [INSPECTOR_CONFIG, CHECK_SCRIPT, DOCKERFILE_INSPECTOR]) {
    assert.equal(existsSync(join(dir, file)), false, `${file} must never land in the repository`);
  }
  assert.equal(result.check, RECORDED_CHECK);
});

// Client ruling on this task: keep existing files, write only what's
// missing. A folder the Client has already edited by hand survives a
// second run byte for byte.
test("register --terms: files already in the folder are kept byte for byte, and only the missing one is written", async () => {
  const recordHome = tempHome();
  const dir = project();
  dropCheckScript(dir);
  commit(dir, { "package.json": JSON.stringify({ scripts: { test: "node --test" } }) });
  const terms = termsFolder();
  writeFileSync(join(terms, INSPECTOR_CONFIG), '{"check":"./check.sh","timeoutSeconds":900}\n');
  writeFileSync(join(terms, CHECK_SCRIPT), "#!/bin/sh\nmy own command\n");

  const result = await registerProject({ recordHome, path: dir, terms }, { tools: fakeRegisterTools() });

  assert.deepEqual(
    (result.termsFiles ?? []).map((file) => [file.file, file.outcome]),
    [
      [INSPECTOR_CONFIG, "kept"],
      [CHECK_SCRIPT, "kept"],
      [DOCKERFILE_INSPECTOR, "written"],
    ]
  );
  assert.equal(readFileSync(join(terms, INSPECTOR_CONFIG), "utf8"), '{"check":"./check.sh","timeoutSeconds":900}\n');
  assert.equal(readFileSync(join(terms, CHECK_SCRIPT), "utf8"), "#!/bin/sh\nmy own command\n");
});

// -------------------------------------------------------- projects.toml

test("register --terms: projects.toml records the folder and noStamp = true, and still parses", async () => {
  const recordHome = tempHome();
  const dir = project();
  const terms = termsFolder();

  const result = await registerProject({ recordHome, path: dir, terms }, { tools: fakeRegisterTools() });

  assert.match(result.tomlEntry, /^terms = /m);
  assert.match(result.tomlEntry, /^noStamp = true$/m);
  const entry = loadConfig(recordHome).projects[result.name];
  assert.equal(entry.terms, terms);
  assert.equal(entry.noStamp, true);
  assert.equal(entry.check, RECORDED_CHECK);
  assert.equal(entry.path, dir);
});

// "Projects registered without --terms are unchanged": neither setting
// appears in an ordinary entry, and absence is the default everywhere.
test("register --terms: a project registered without it gets neither setting", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: true });

  const result = await registerProject({ recordHome, path: dir }, { tools: fakeRegisterTools() });

  assert.equal(result.kind, "registry-only");
  assert.doesNotMatch(result.tomlEntry, /terms|[Ss]tamp/);
  const entry = loadConfig(recordHome).projects[result.name];
  assert.equal(entry.terms, undefined);
  assert.equal(entry.noStamp, undefined);
});

// ------------------------------------------------------------- refusals

// The four prerequisites this route skips are all prerequisites of
// pushing, and it pushes nothing - so a logged-out gh and a stopped
// Docker daemon must not refuse a setup this machine can do.
test("register --terms: a logged-out gh and a stopped Docker daemon do not refuse it", async () => {
  const recordHome = tempHome();
  const dir = project();
  const terms = termsFolder();
  const tools = fakeRegisterTools({
    gh: { ok: false, detail: "gh is not logged in", fix: "gh auth login" },
    docker: { ok: false, detail: "the Docker daemon is not reachable" },
  });

  const result = await registerProject({ recordHome, path: dir, terms }, { tools });

  assert.equal(result.kind, "terms");
});

// Accepting and ignoring one of them would be a silent skip - there is
// no commit for a --check command to land in and no proving run for
// --image to be pulled by.
test("register --terms: it refuses the flags that only describe the repository route, naming them", async () => {
  const recordHome = tempHome();
  const dir = project();
  const terms = termsFolder();

  const cases: [string, Partial<Parameters<typeof registerProject>[0]>][] = [
    ["--check", { check: "npm test" }],
    ["--image", { image: "node:24" }],
    ["--timeout", { timeoutSeconds: 600 }],
    ["--protected", { protectedPaths: ["docs/**"] }],
  ];
  for (const [flag, extra] of cases) {
    await assert.rejects(
      registerProject({ recordHome, path: dir, terms, ...extra }, { tools: fakeRegisterTools() }),
      (err: unknown) =>
        err instanceof RegisterError &&
        err.code === "terms-with-repository-flags" &&
        err.message.includes(flag) &&
        err.message.includes("Nothing was changed"),
      flag
    );
  }
  assert.equal(existsSync(projectsTomlPath(recordHome)), false);
  assert.equal(existsSync(join(terms, INSPECTOR_CONFIG)), false);
});

test("register --terms: a folder that does not exist refuses, naming the mkdir, and creates nothing", async () => {
  const recordHome = tempHome();
  const dir = project();
  const missing = join(termsFolder(), "not", "there");

  await assert.rejects(
    registerProject({ recordHome, path: dir, terms: missing }, { tools: fakeRegisterTools() }),
    (err: unknown) =>
      err instanceof RegisterError && err.code === "terms-unusable" && err.message.includes("mkdir -p")
  );
  assert.equal(existsSync(missing), false, "a mistyped path must never become a folder");
  assert.equal(existsSync(projectsTomlPath(recordHome)), false);
});

test("register --terms: a path that is a file, not a folder, refuses", async () => {
  const recordHome = tempHome();
  const dir = project();
  const file = join(termsFolder(), "terms.json");
  writeFileSync(file, "{}\n");

  await assert.rejects(
    registerProject({ recordHome, path: dir, terms: file }, { tools: fakeRegisterTools() }),
    (err: unknown) =>
      err instanceof RegisterError && err.code === "terms-unusable" && err.message.includes("is not a folder")
  );
});

// In the repository, the terms are in every worker's own checkout -
// editable by the very task they exist to judge.
test("register --terms: a folder inside the repository refuses, the repository root included", async () => {
  const recordHome = tempHome();
  const dir = project();
  mkdirSync(join(dir, "terms"));

  for (const inside of [dir, join(dir, "terms")]) {
    await assert.rejects(
      registerProject({ recordHome, path: dir, terms: inside }, { tools: fakeRegisterTools() }),
      (err: unknown) =>
        err instanceof RegisterError &&
        err.code === "terms-inside-repo" &&
        err.message.includes("every worker's own checkout"),
      inside
    );
  }
  assert.equal(existsSync(projectsTomlPath(recordHome)), false);
});

// Two sets of terms for one repository could only ever disagree about
// how work on it is judged.
test("register --terms: a repository already carrying .inspector.json on origin refuses", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: true });
  const terms = termsFolder();

  await assert.rejects(
    registerProject({ recordHome, path: dir, terms }, { tools: fakeRegisterTools() }),
    (err: unknown) =>
      err instanceof RegisterError &&
      err.code === "terms-not-needed" &&
      err.message.includes("without --terms")
  );
  assert.equal(existsSync(projectsTomlPath(recordHome)), false);
  assert.equal(existsSync(join(terms, INSPECTOR_CONFIG)), false);
});

// prepare()'s own refusals still bind this route: it is a registration,
// and a second one for the same repository is still a duplicate.
test("register --terms: a project already registered still refuses, before anything is written", async () => {
  const recordHome = tempHome();
  const dir = project();
  const terms = termsFolder();

  await registerProject({ recordHome, path: dir, terms }, { tools: fakeRegisterTools() });
  const secondTerms = termsFolder();

  await assert.rejects(
    registerProject({ recordHome, path: dir, terms: secondTerms, name: "another-name" }, { tools: fakeRegisterTools() }),
    (err: unknown) => err instanceof RegisterError && err.code === "already-registered"
  );
  assert.equal(existsSync(join(secondTerms, INSPECTOR_CONFIG)), false);
});
