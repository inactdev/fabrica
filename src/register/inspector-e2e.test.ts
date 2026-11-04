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
// FOUR THINGS TO KNOW BEFORE CHANGING ANYTHING HERE:
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

/** A file the fixture tracks inside a directory git would not ignore a
 * new file in - `helpers/rails-app-fixture.ts` writes it. Asserted to be
 * tracked below, so a fixture that dropped it says so. */
const TRACKED_FILE = "app/models/widget.rb";

/** A new file in that same directory, which git would not ignore - so
 * the box must refuse to create it. */
const NEW_TRACKED_DIR_FILE = "app/models/fabrica-probe.rb";

/** Whether git would ignore this path - the question inspector#85's rule
 * turns on, asked of git itself rather than read off `.gitignore`.
 * `check-ignore -q` exits 0 for an ignored path and 1 for any other. */
function gitIgnores(repo: string, path: string): boolean {
  const run = spawnSync("git", ["check-ignore", "-q", "--", path], { cwd: repo, encoding: "utf8" });
  assert.ok(
    run.status === 0 || run.status === 1,
    `git check-ignore could not answer for ${path}: ${run.status} ${run.stderr}`
  );
  return run.status === 0;
}

/**
 * The check that reports on the box rather than passing in it.
 *
 * Every rule prints one line the test looks for, or exits 1 naming what
 * it found instead - so a rule can neither fail silently nor go
 * unproven behind a green verdict.
 */
const PROBE_SCRIPT = `#!/bin/sh
# Issue #337's premises about Inspector's own check box, read from
# inside the box. Deliberately without \`set -e\`: half of this is
# commands that are supposed to fail.

fail() {
  echo "PROBE FAILED: $1" >&2
  exit 1
}

# Writable where git would ignore a new file (inspector#85). Written and
# read back rather than \`touch\`ed: the rule is about creating a file,
# and touching one that is already there succeeds for another reason.
for dir in log tmp; do
  new="$dir/fabrica-probe-new"
  if ! ( printf 'fabrica' > "$new" ) 2>/dev/null; then
    fail "$dir/ refused a new file, and git ignores new files there"
  fi
  if [ "$(cat "$new" 2>/dev/null)" != "fabrica" ]; then
    fail "$dir/ took a new file without keeping its contents"
  fi
  echo "$dir/ accepts a new file"
done

# A tracked file is immutable even so, in all three of the ways it could
# stop being: modified, removed, replaced. Each is attempted and must
# fail, and the file is re-read afterwards - so an attempt that
# succeeded and was undone can never read as a refusal.
immutable() {
  path="$1"
  before="$(cat "$path" 2>/dev/null)" || fail "$path is not even readable in the check box"
  if ( printf 'x' >> "$path" ) 2>/dev/null; then
    fail "$path could be appended to, and a tracked file must be immutable"
  fi
  if rm -f "$path" 2>/dev/null; then
    fail "$path could be removed, and a tracked file must be immutable"
  fi
  # A rename over it, from the one directory already proven writable.
  if mv tmp/fabrica-probe-new "$path" 2>/dev/null; then
    fail "$path could be replaced, and a tracked file must be immutable"
  fi
  [ -e "$path" ] || fail "$path is gone after the attempts above"
  [ "$(cat "$path" 2>/dev/null)" = "$before" ] || fail "$path changed after the attempts above"
  echo "$path is immutable"
}

# Read-only where git would NOT ignore a new file: both for a file that
# is not there yet, and for one that is.
if ( printf 'x' > "${NEW_TRACKED_DIR_FILE}" ) 2>/dev/null; then
  fail "${NEW_TRACKED_DIR_FILE} could be created, and git would not ignore it"
fi
echo "${NEW_TRACKED_DIR_FILE} cannot be created"
immutable ${TRACKED_FILE}
immutable log/.keep
immutable tmp/.keep

rm -f log/fabrica-probe-new tmp/fabrica-probe-new 2>/dev/null

# Reported rather than asserted here, because both answers are real:
# Inspector resolves the check's user to the uid that invoked it, and to
# 0:0 under a rootless Docker daemon. The test is what decides what each
# one means.
if getent passwd "$(id -u)" > /dev/null 2>&1; then
  echo "check box uid $(id -u) has a passwd entry"
else
  echo "check box uid $(id -u) has no passwd entry"
fi
`;

// The facts about Inspector's own box that the four findings rest on,
// asserted from inside it rather than taken from its documentation.
//
// All of them are already load-bearing for the two green checks above -
// the fixture boots Rails twice, writing into `log/` and `tmp/`, as
// whatever user Inspector picked - but a failure there says only "red".
// This says which fact changed.
//
//   - the box is writable where git would ignore a new file
//     (inspector#85), which in this fixture means `log/` and `tmp/`: a
//     `rails new` application ignores `/log/*` and `/tmp/*` and tracks a
//     `.keep` inside each. That is what lets Rails write
//     `tmp/local_secret.txt` without turning the check red.
//   - a tracked file is still immutable, `.keep` included: writable
//     where a *new* file would be ignored is not writable generally, and
//     a check that could rewrite the repository under itself would make
//     every verdict meaningless.
//   - a tracked directory git would not ignore a new file in - `app/`
//     here - is read-only for new files as well as existing ones.
//   - the check runs as a uid with no /etc/passwd entry, which is the
//     whole reason the generated check gives that uid an entry of its
//     own and then creates its database cluster at check time with trust
//     authentication.
//
// One probe, one box, four facts: they are all properties of the same
// mount layout, and a separate Inspector run for each would cost a real
// image build apiece and prove nothing more.
test("the check box is writable only where git would ignore a new file, and runs as a uid with no passwd entry", (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");

  const repo = railsRepository();
  // The fixture's premises, checked here so a fixture that drifted says
  // so instead of quietly making the probe trivial.
  for (const path of ["log/.keep", "tmp/.keep", TRACKED_FILE]) {
    assert.equal(
      git(repo, ["ls-files", "--", path]),
      path,
      `${path} has to be tracked for this fixture to be the shape rails new leaves - without it there is ` +
        `nothing here for the immutability half to be about`
    );
  }
  for (const dir of ["log", "tmp"]) {
    assert.equal(
      gitIgnores(repo, `${dir}/fabrica-probe`),
      true,
      `git has to ignore a new file in ${dir}/ for this fixture to be the shape rails new leaves - without ` +
        `it the writable half is not about the rule inspector#85 introduced`
    );
  }
  assert.equal(
    gitIgnores(repo, NEW_TRACKED_DIR_FILE),
    false,
    `git must NOT ignore ${NEW_TRACKED_DIR_FILE}, or the read-only half of this test has nothing to prove`
  );

  // Proven in the box the check actually runs in - the one place these
  // mounts exist.
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
  writeFileSync(probe, PROBE_SCRIPT);

  const report = runInspector(repo, terms);
  assert.equal(report.outcome, "green", reportDetail(report));
  const output = report.output ?? "";
  // Each rule prints its own line, and each line is asserted: a probe
  // that died halfway through would otherwise be a green check with a
  // rule silently unproven.
  for (const line of [
    "log/ accepts a new file",
    "tmp/ accepts a new file",
    "log/.keep is immutable",
    "tmp/.keep is immutable",
    `${NEW_TRACKED_DIR_FILE} cannot be created`,
    `${TRACKED_FILE} is immutable`,
  ]) {
    assert.ok(output.includes(line), `the probe never reported "${line}":\n${reportDetail(report)}`);
  }

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
