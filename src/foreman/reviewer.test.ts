// The round's own refusal, asked of the commit a task was cut from.
// `fabrica do` refuses the same three ways up front; this is what makes
// a resumed round, a fix round, and a library caller that never went
// through the CLI refuse too, rather than handing Inspector a
// configuration that cannot work.
//
// No vendor is named by hand here: CONTRACT rule 8's scan covers test
// files too, so the worker's own vendor is asked of `workerVendor`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { makeTestHome } from "../config/helpers/test-home.ts";
import { brainEnvPath, workerVendor } from "../brain/index.ts";
import { apiKeyVarFor } from "../reviewer/index.ts";
import { ForemanError } from "./errors.ts";
import { requireReviewer } from "./reviewer.ts";

const REVIEWING_VENDOR = "second-opinion";

/** A fixture repo whose committed `.inspector.json` declares testPaths -
 * the key that makes a reviewer mandatory. */
function repoAskingForTestJudgement(): string {
  const project = makeFixtureRepo("exit 0");
  writeFileSync(join(project, ".inspector.json"), '{"check":"./check.sh","image":"alpine","testPaths":"*.test.ts"}\n');
  execFileSync("git", ["add", "-A"], { cwd: project });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "judge my tests"], { cwd: project });
  return project;
}

function withKey(recordHome: string, vendor: string): string {
  const path = brainEnvPath(recordHome);
  writeFileSync(path, `${apiKeyVarFor(vendor)}=secret-review-key\n`);
  chmodSync(path, 0o600);
  return recordHome;
}

test("requireReviewer: a project declaring testPaths with no reviewer refuses the round", () => {
  const project = repoAskingForTestJudgement();
  const recordHome = makeTestHome("");

  assert.throws(
    () => requireReviewer(recordHome, project, project, "HEAD"),
    (err: unknown) => {
      assert.ok(err instanceof ForemanError);
      assert.equal(err.code, "reviewer-not-ready");
      assert.match(err.message, /\[reviewer\]/);
      return true;
    }
  );
});

test("requireReviewer: a project declaring no testPaths and configuring nothing needs no reviewer", () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = makeTestHome("");

  assert.equal(requireReviewer(recordHome, project, project, "HEAD"), undefined);
});

test("requireReviewer: a configured, usable reviewer is what the round hands Inspector", () => {
  const project = repoAskingForTestJudgement();
  const recordHome = withKey(
    makeTestHome(`
      [reviewer]
      vendor = "${REVIEWING_VENDOR}"
      model = "careful-reader"
    `),
    REVIEWING_VENDOR
  );

  const reviewer = requireReviewer(recordHome, project, project, "HEAD");

  assert.ok(reviewer);
  assert.equal(reviewer.vendor, REVIEWING_VENDOR);
  assert.equal(reviewer.model, "careful-reader");
});

test("requireReviewer: the worker's own vendor is refused as a reviewer, naming both", () => {
  const project = repoAskingForTestJudgement();
  const recordHome = makeTestHome("");
  const worker = workerVendor({}, recordHome);
  writeFileSync(join(recordHome, "projects.toml"), `[reviewer]\nvendor = "${worker}"\nmodel = "same-house"\n`);
  withKey(recordHome, worker);

  assert.throws(
    () => requireReviewer(recordHome, project, project, "HEAD"),
    (err: unknown) => {
      assert.ok(err instanceof ForemanError);
      assert.equal(err.code, "reviewer-not-ready");
      assert.match(err.message, new RegExp(worker));
      return true;
    }
  );
});

test("requireReviewer: a record home with no projects.toml at all is not an error", () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = makeTestHome("");
  // makeTestHome always writes one; prove the no-file path too by
  // pointing at a directory that has none.
  const emptyHome = join(recordHome, "nothing-here");
  mkdirSync(emptyHome);

  assert.equal(requireReviewer(emptyHome, project, project, "HEAD"), undefined);
});

// The worker must never be able to decide who reviews it: testPaths is
// read at the task's base commit, not from the worktree the worker has
// already had its hands on.
test("requireReviewer: adding testPaths in the worktree does not make a reviewer required", () => {
  const project = makeFixtureRepo("exit 0");
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim();
  writeFileSync(join(project, ".inspector.json"), '{"check":"./check.sh","testPaths":"*.test.ts"}\n');
  const recordHome = makeTestHome("");

  assert.equal(requireReviewer(recordHome, project, project, baseCommit), undefined);
});
