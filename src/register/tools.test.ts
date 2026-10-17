// The outside-this-machine half of `fabrica register`. Most of it can
// only be proven with the real thing present, so this file splits:
//
//   - `pullRequestUrlIn` is pure and always runs.
//   - the real containerized check run is Docker-gated, skipping (never
//     failing) without a daemon, the same convention every other
//     Docker-dependent test here follows. `.github/workflows/
//     docker-tests.yml` runs the ordinary suite on a Docker-equipped
//     runner, with a `docker info` guard so a hollow all-skipped pass
//     can't happen - so this genuinely runs there.
//
// What stays unproven by any test, deliberately: `realGhStatus` and
// `realOpenPullRequest` would need a logged-in `gh` and a real GitHub
// repository to open a real pull request against. Both are reported
// honestly rather than faked into a green tick - see src/brain/adapters/
// README.md's "Guarding a fake against drift from the real thing" for
// the same posture on the one test that drives a real binary.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { createProductionLine, destroyProductionLine } from "../line/index.ts";
import { pullRequestUrlIn, realRegisterTools } from "./tools.ts";
import { RECORDED_CHECK } from "./origin.ts";

// Plain `alpine` - the image contract/helpers/fixture.ts's
// FIXTURE_INSPECTOR_CONFIG names too, so the fixtures and this test
// agree on one stock image. Deliberately not an image with its own
// entrypoint: runContained passes the command straight after the image
// name with no --entrypoint override, so `alpine/git` (whose entrypoint
// IS git) would run `git sh -c ./check.sh` and fail for a reason that
// has nothing to do with the check. src/line/worktree-git.test.ts can
// use alpine/git because it passes git subcommands as the command.
const CHECK_IMAGE = "alpine";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// gh's documented behavior: the new pull request's URL goes to stdout on
// success - and it can exit non-zero having already printed one, which is
// why this is read out of the output rather than inferred from the status.
test("pullRequestUrlIn finds the pull request URL gh printed", () => {
  assert.equal(
    pullRequestUrlIn("https://github.com/inactdev/fabrica/pull/231\n"),
    "https://github.com/inactdev/fabrica/pull/231"
  );
  assert.equal(
    pullRequestUrlIn("Warning: 1 uncommitted change\n\nhttps://github.com/o/r/pull/7\n"),
    "https://github.com/o/r/pull/7"
  );
  assert.equal(
    pullRequestUrlIn("https://git.example.com/team/repo/pull/12"),
    "https://git.example.com/team/repo/pull/12"
  );
});

test("pullRequestUrlIn is null when gh printed no pull request at all", () => {
  assert.equal(pullRequestUrlIn(""), null);
  assert.equal(pullRequestUrlIn("gh: could not create pull request\n"), null);
  // An issue URL is not a pull request URL.
  assert.equal(pullRequestUrlIn("https://github.com/o/r/issues/7\n"), null);
});

test("realRegisterTools.runCheck runs the command inside the image, against the worktree", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");

  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-register-tools-home-"));
  const line = createProductionLine({
    project: makeFixtureRepo("exit 0"),
    taskId: "register-tools-green",
    recordHome,
  });

  try {
    const green = await realRegisterTools.runCheck({
      workdir: line.workdir,
      image: CHECK_IMAGE,
      command: RECORDED_CHECK,
    });
    assert.equal(green.ran, true, `the box should have run the check: ${JSON.stringify(green)}`);
    assert.equal(green.ran && green.exitCode, 0, "the fixture's check.sh exits 0");

    // The same box reports a red check as red, not as "could not run".
    const red = await realRegisterTools.runCheck({
      workdir: line.workdir,
      image: CHECK_IMAGE,
      command: "exit 7",
    });
    assert.equal(red.ran, true);
    assert.equal(red.ran && red.exitCode, 7);

    // git works in there, through the read-only mounts - a real project's
    // check often shells out to it. Installed first, rather than run from
    // an image that ships it: `runCheck` allows the network for exactly
    // this reason (a real check installs what it needs), and this is that
    // case in miniature.
    const gitWorks = await realRegisterTools.runCheck({
      workdir: line.workdir,
      image: CHECK_IMAGE,
      command: "apk add -q git && git status",
    });
    assert.equal(gitWorks.ran, true);
    assert.equal(gitWorks.ran && gitWorks.exitCode, 0, `git should work inside the box: ${JSON.stringify(gitWorks)}`);
  } finally {
    destroyProductionLine(line);
  }
});

// A missing image is "could not run", never a red check: nothing about
// the project's own check is proven either way, and register refuses
// with a different message for each.
test("realRegisterTools.runCheck reports a box it could not start as not run, never as red", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");

  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-register-tools-noimage-"));
  const line = createProductionLine({
    project: makeFixtureRepo("exit 0"),
    taskId: "register-tools-no-image",
    recordHome,
  });

  try {
    const result = await realRegisterTools.runCheck({
      workdir: line.workdir,
      image: "fabrica-no-such-image:does-not-exist",
      command: RECORDED_CHECK,
    });
    // Docker reports a missing image as a non-zero exit of `docker run`
    // itself rather than a spawn failure, so either shape is acceptable -
    // what must never happen is a *zero* exit code read as a passing check.
    if (result.ran) {
      assert.notEqual(result.exitCode, 0, "a missing image must never look like a passing check");
    } else {
      assert.match(result.reason, /fabrica-no-such-image/);
    }
  } finally {
    destroyProductionLine(line);
  }
});

// Not Docker-gated: this is about the mounts failing to resolve, which
// needs no daemon at all - a plain directory is not a git worktree.
test("realRegisterTools.runCheck reports an unresolvable workdir as not run, with an instructive reason", async () => {
  const notAWorktree = mkdtempSync(join(tmpdir(), "fabrica-register-tools-plain-"));

  const result = await realRegisterTools.runCheck({
    workdir: notAWorktree,
    image: CHECK_IMAGE,
    command: RECORDED_CHECK,
  });

  assert.equal(result.ran, false);
  assert.equal(!result.ran && result.reason.includes("could not prepare the container"), true);
});
