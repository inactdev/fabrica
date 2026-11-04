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
//     #337 this is deliberate.
//   - **Both routes are expected green**, and two facts about the pinned
//     Inspector are what make that reachable: the named `repo` build
//     context a terms folder's Dockerfile copies the repository out of
//     (inspector#83), and a check box that is writable where git would
//     ignore a new file (inspector#85) - Rails writes
//     `tmp/local_secret.txt` when it has no configured
//     `secret_key_base`, and `tmp/*` is git-ignored in any `rails new`
//     application. Nothing here works around either: an older pin is a
//     red naming its own cause, which is the point.
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

function resolvedGemfileLock(files: Record<string, string>): string {
  if (lockfile !== null) return lockfile;
  const dir = mkdtempSync(join(tmpdir(), "fabrica-bundle-lock-"));
  // The whole application, not the Gemfile alone: it names a gem kept in
  // the repository (`path: "engines/..."`), and bundler cannot resolve
  // one of those without reading the gemspec in that directory.
  writeRailsApp(dir, files);
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
  writeFileSync(join(dir, "Gemfile.lock"), resolvedGemfileLock(files));
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

// The two facts about Inspector's own box that the four findings rest
// on, asserted from inside it rather than taken from its documentation.
//
// Both are already load-bearing for the two green checks above - the
// fixture boots Rails twice, into read-only log/ and tmp/, as whatever
// user Inspector picked - but a failure there says only "red". This says
// which fact changed.
//
//   - log/ and tmp/ are tracked in this fixture the way `rails new`
//     tracks them, and Inspector mounts every tracked top-level path
//     read-only.
//   - the check runs as a uid with no /etc/passwd entry, which is the
//     whole reason the generated check gives that uid an entry of its
//     own and then creates its database cluster at check time with trust
//     authentication.
test("the check box is read-only where git tracks, and runs as a uid with no passwd entry", (t) => {
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
      `echo "log and tmp are both read-only, as expected"\n` +
      `# Reported rather than asserted here, because both answers are\n` +
      `# real: Inspector resolves the check's user to the uid that\n` +
      `# invoked it, and to 0:0 under a rootless Docker daemon. The\n` +
      `# test below is what decides what each one means.\n` +
      `if getent passwd "$(id -u)" > /dev/null 2>&1; then\n` +
      `  echo "check box uid $(id -u) has a passwd entry"\n` +
      `else\n` +
      `  echo "check box uid $(id -u) has no passwd entry"\n` +
      `fi\n`
  );

  const report = runInspector(repo, terms);
  assert.equal(report.outcome, "green", reportDetail(report));
  const output = report.output ?? "";
  assert.ok(output.includes("both read-only"), reportDetail(report));

  // Issue #337's fourth finding, which is the one with no visible
  // signature in a red check: the generated PostgreSQL setup exists
  // because this uid has no name anywhere in the box, so there is
  // nothing for initdb to look itself up as until the check writes an
  // entry, "peer" authentication has nothing to resolve, and nothing may
  // be created for it at build time. This probe is a box of its own, with
  // no generated check in it, so the premise is read as Inspector leaves
  // it. If it ever stops holding, this says so instead of leaving a
  // passing suite to imply it was tested.
  const user = /check box uid (\d+) has (a|no) passwd entry/.exec(output);
  assert.ok(user !== null, `the probe did not report the box's own user:\n${reportDetail(report)}`);
  if (user[1] === "0") {
    // The rootless-Docker answer. Legitimate, and the generated check
    // has its own branch for it (dockerfile.ts's `pg_as`), so this is
    // recorded rather than failed on - but it means this run proved the
    // root branch and not the other one.
    t.diagnostic(`the check box ran as root: this run exercised pg_as's root branch, not the uid branch`);
  } else {
    assert.equal(
      user[2],
      "no",
      `the check box ran as uid ${user[1]}, and that uid DOES have a passwd entry - so this run did not ` +
        `exercise the case the generated PostgreSQL setup is written for:\n${reportDetail(report)}`
    );
    t.diagnostic(`the check box ran as uid ${user[1]}, with no passwd entry`);
  }
});
