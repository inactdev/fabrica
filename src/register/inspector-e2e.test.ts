// What `fabrica register` writes, judged by the real Inspector (issue
// #337).
//
// Every other test in this directory asserts on the *text* of the three
// files. That is exactly what let four separate mistakes ship: the
// config named a script Inspector would look for in the wrong place, the
// script changed into the wrong directory, the Dockerfile copied from
// the wrong build context, and the servers were set up at build time for
// a user the check would never run as. Every one of them read as correct
// in a substring assertion, and every one of them is only visible when
// something actually runs the check.
//
// So this file does. It builds a Rails application that really boots
// (`helpers/rails-app-fixture.ts`), registers it both ways, and hands
// each one to the installed `inspector`.
//
// THREE THINGS TO KNOW BEFORE CHANGING ANYTHING HERE:
//
//   - **It skips only when Docker is absent**, which is the one thing
//     genuinely unavailable on a machine (and is guaranteed present in
//     `.github/workflows/docker-tests.yml`, which runs this). Anything
//     else - no `inspector` on PATH, a failed image build, a red check -
//     FAILS, loudly, naming what happened. By Client ruling on issue
//     #337 this is deliberate: the terms route needs inspector#81's
//     named build context, so until the pin in that workflow includes
//     it, the terms test here genuinely fails rather than quietly
//     skipping.
//   - **The verdict is read from Inspector's own report, never from its
//     exit code.** `inspector` cannot run a check without publishing:
//     `-branch` is required, and a missing GITHUB_TOKEN is a refusal
//     with exit 2. But its `Run` writes `.inspector/latest.json` as soon
//     as the check has finished and before any of that, so
//     `outcome: "green"` is the fact to read - and no publication is
//     ever attempted, which is what keeps this test off the network.
//   - **It is slow, on purpose.** Two real image builds, each installing
//     PostgreSQL, Redis and the whole Rails bundle. The fixture's
//     `Gemfile.lock` is resolved once, by a real `bundle lock`, and
//     shared by both.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFixtureRepo, pushToOrigin } from "../../contract/helpers/fixture.ts";
import { registerProject } from "./register.ts";
import { fakeRegisterTools } from "./helpers/fake-register-tools.ts";
import { CHECK_SCRIPT, INSPECTOR_CONFIG, REGISTER_BRANCH } from "./origin.ts";
import { FIXTURE_IMAGE, railsAppFiles, writeRailsApp } from "./helpers/rails-app-fixture.ts";

/** The one condition this file skips on - see the header. */
function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * The fixture's real `Gemfile.lock`, resolved by bundler itself inside
 * the same image the check box is built from - so the lockfile the
 * image installs from is one bundler wrote for this Ruby, not one
 * written by hand that bundler would quietly re-resolve into something
 * else.
 *
 * Resolved once per run and reused: it is a network round trip to
 * rubygems and the slowest part of the setup that is not an image build.
 */
let lockfile: string | null = null;

function resolvedGemfileLock(gemfile: string): string {
  if (lockfile !== null) return lockfile;
  const dir = mkdtempSync(join(tmpdir(), "fabrica-bundle-lock-"));
  writeFileSync(join(dir, "Gemfile"), gemfile);
  const run = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${dir}:/lock`,
      "-w",
      "/lock",
      FIXTURE_IMAGE,
      "bundle",
      "lock",
      // One platform, the one both the image build and the check run
      // on. A lockfile carrying others would have bundler resolving
      // gems for a platform this never installs.
      "--add-platform",
      "x86_64-linux",
    ],
    { encoding: "utf8" }
  );
  assert.equal(
    run.status,
    0,
    `\`bundle lock\` could not resolve the fixture's Gemfile inside ${FIXTURE_IMAGE}:\n` +
      `${run.stdout}\n${run.stderr}`
  );
  lockfile = readFileSync(join(dir, "Gemfile.lock"), "utf8");
  return lockfile;
}

/**
 * A git repository holding the Rails application, with its own bare
 * origin - `register` reads every signal off origin's default branch,
 * never off a working tree, so the application has to be pushed there
 * before either route runs.
 */
function railsRepository(): string {
  const files = railsAppFiles();
  const dir = makeFixtureRepo("exit 0", { inspector: false });
  git(dir, ["config", "user.email", "client@example.test"]);
  git(dir, ["config", "user.name", "The Client"]);
  // The fixture repo's own check.sh goes: this project's check is one
  // `register` derives, and an existing script would win over every
  // other signal.
  git(dir, ["rm", "-q", CHECK_SCRIPT]);

  writeRailsApp(dir, files);
  writeFileSync(join(dir, "Gemfile.lock"), resolvedGemfileLock(files.Gemfile));
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "a Rails application"]);
  pushToOrigin(dir);
  return dir;
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Inspector's own report for the last run against this repository. */
interface InspectorReport {
  outcome?: string;
  checkCommand?: string;
  termsDir?: string;
  output?: string;
}

/**
 * Runs the installed `inspector` over `repo` and returns what its own
 * report says about the check.
 *
 * The exit code is deliberately not asserted on: publication is welded
 * into the command (`-branch` is required) and this test gives it no
 * credential, so it refuses with exit 2 after the check has already run
 * and been reported. A refusal before the check leaves no report at all,
 * which is what the assertion below catches - with Inspector's own
 * output, so the reason is in the failure rather than lost.
 */
function runInspector(repo: string, terms?: string): InspectorReport {
  const args = ["-repo", repo, "-branch", "fabrica/inspector-e2e"];
  if (terms !== undefined) args.push("-terms", terms);

  const run = spawnSync("inspector", args, {
    encoding: "utf8",
    // Nothing of this machine's own: no GITHUB_TOKEN to publish with,
    // and no vendor credential for the reviewer half.
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    // A real image build plus a real Rails suite. Generous rather than
    // tuned: a timeout here reports as a missing report, which would be
    // a confusing way to say "it was still working".
    timeout: 45 * 60 * 1000,
  });

  if (run.error !== undefined && (run.error as NodeJS.ErrnoException).code === "ENOENT") {
    assert.fail(
      `\`inspector\` is not on PATH, and this test does not skip for that - it is the whole point of the ` +
        `test. Install the pinned commit the way .github/workflows/docker-tests.yml does ` +
        `(\`go install github.com/inactdev/inspector/cmd/inspector@<commit>\`), then run this again.`
    );
  }

  const path = join(repo, ".inspector", "latest.json");
  assert.ok(
    existsSync(path),
    `inspector wrote no report at all, so it refused before it ever ran the check (exit ${run.status}):\n` +
      `${run.stdout}\n${run.stderr}`
  );
  return JSON.parse(readFileSync(path, "utf8")) as InspectorReport;
}

/** The lines worth putting in a failure message: a red check's own
 * output is the only thing that says which of the four findings came
 * back. */
function reportDetail(report: InspectorReport): string {
  return `outcome=${report.outcome} check=${report.checkCommand}\n${report.output ?? "(no output recorded)"}`;
}

// --------------------------------------------------- the terms route

test("register --terms: the terms it writes pass a real Inspector run", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");

  const repo = railsRepository();
  const terms = tempDir("fabrica-e2e-terms-");
  const recordHome = tempDir("fabrica-e2e-home-");

  await registerProject({ recordHome, path: repo, terms }, { tools: fakeRegisterTools() });

  const report = runInspector(repo, terms);

  assert.equal(report.outcome, "green", reportDetail(report));
  // The two facts about this run that make the green mean what it is
  // supposed to mean: the check Inspector ran is the one in the folder,
  // and the folder is the one register wrote.
  assert.equal(report.checkCommand, "sh /terms/check.sh", reportDetail(report));
  assert.ok(report.termsDir !== undefined, reportDetail(report));
});

// ------------------------------------------- the in-repository route

test("register: the files it commits into a repository pass a real Inspector run", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");

  const repo = railsRepository();
  const recordHome = tempDir("fabrica-e2e-home-");

  // The real registration, with only the four outside-this-machine
  // things faked (`gh`, the Docker daemon probe, the proving run, `gh pr
  // create`) - the commit onto fabrica/register and the push to the
  // fixture's own bare origin are real, so what Inspector judges below
  // is the commit this command actually made.
  //
  // The proving run is among the faked four for a reason this test then
  // makes moot: it runs the check inside the image --image names and
  // never builds Dockerfile.inspector, so PostgreSQL and Redis are not
  // installed there (see register.ts's `servicesCaveat`). Inspector
  // builds the real box, which is what proves the check for real.
  await registerProject(
    { recordHome, path: repo, check: "bundle exec rspec", image: FIXTURE_IMAGE },
    { tools: fakeRegisterTools() }
  );

  git(repo, ["checkout", "-q", REGISTER_BRANCH]);
  assert.ok(existsSync(join(repo, INSPECTOR_CONFIG)), "the registration branch should carry the three files");

  const report = runInspector(repo);

  assert.equal(report.outcome, "green", reportDetail(report));
  assert.equal(report.checkCommand, "./check.sh", reportDetail(report));
  // In-repository terms, so there is no terms folder on the record -
  // which is the one way this run differs from the one above.
  assert.equal(report.termsDir, undefined, reportDetail(report));
});

// ---------------------------------------------- what the box can write

// The specific trap issue #337 names: Rails writes into log/ and tmp/,
// both of which git tracks in this fixture the way `rails new` tracks
// them, and Inspector mounts every tracked top-level path read-only. A
// green check above already depends on this - the fixture boots Rails
// twice, for db:test:prepare and for the suite - and this asserts it
// directly, so a regression says what broke rather than only that
// something did.
test("the check box cannot write into the Rails directories git tracks, and the check is green anyway", (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");

  const repo = railsRepository();
  for (const path of ["log/.keep", "tmp/.keep"]) {
    assert.equal(
      git(repo, ["ls-files", "--", path]),
      path,
      `${path} has to be tracked for this fixture to be the shape rails new leaves - without it, log/ and ` +
        `tmp/ are untracked and writable in the check box, and nothing here is being tested`
    );
  }

  // Proven in the box the check actually runs in - the one place the
  // read-only mounts exist.
  const terms = tempDir("fabrica-e2e-terms-");
  const probe = join(terms, "probe.sh");

  // Written by hand rather than registered: this is a question about
  // Inspector's own mounts, not about what register derives, and the
  // check it runs has to be one that reports rather than one that
  // passes.
  writeFileSync(
    join(terms, INSPECTOR_CONFIG),
    `${JSON.stringify({ check: "sh /terms/probe.sh" }, null, 2)}\n`
  );
  writeFileSync(join(terms, "Dockerfile.inspector"), `FROM ${FIXTURE_IMAGE}\n`);
  writeFileSync(
    probe,
    `#!/bin/sh\n` +
      `# Fails if either directory turns out to be writable, since then\n` +
      `# this fixture is not the shape the read-only finding is about.\n` +
      `for dir in log tmp; do\n` +
      `  if touch "$dir/fabrica-probe" 2>/dev/null; then\n` +
      `    echo "$dir is writable inside the check box" >&2\n` +
      `    exit 1\n` +
      `  fi\n` +
      `done\n` +
      `echo "log and tmp are both read-only, as expected"\n`
  );

  const report = runInspector(repo, terms);
  assert.equal(report.outcome, "green", reportDetail(report));
  assert.ok((report.output ?? "").includes("both read-only"), reportDetail(report));
});
