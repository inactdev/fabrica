import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitWorktreeChanges } from "./commit.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";

test("commitWorktreeChanges stages and commits everything, without needing a git identity configured", () => {
  const repo = makeFixtureRepo();
  writeFileSync(join(repo, "app.txt"), "changed\n");
  writeFileSync(join(repo, "new-file.txt"), "new\n");

  commitWorktreeChanges(repo, "fabrica: task-1");

  const log = execFileSync("git", ["log", "--format=%s"], { cwd: repo, encoding: "utf8" }).trim();
  assert.equal(log.split("\n")[0], "fabrica: task-1");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }), "");
});

// --no-verify alone only bypasses pre-commit and commit-msg, so a project
// whose hooks include prepare-commit-msg (one needing dependencies a fresh
// worktree does not have is the real-world case) could still abort this
// commit - and the caller force-removes the worktree the moment it throws.
test("commitWorktreeChanges commits even when a project hook outside --no-verify's reach fails", () => {
  const repo = makeFixtureRepo();
  const hook = join(repo, ".git", "hooks", "prepare-commit-msg");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  writeFileSync(join(repo, "app.txt"), "changed\n");

  commitWorktreeChanges(repo, "fabrica: task-1");

  const log = execFileSync("git", ["log", "--format=%s"], { cwd: repo, encoding: "utf8" }).trim();
  assert.equal(log.split("\n")[0], "fabrica: task-1");
});

// A dirty workdir that stages nothing (a submodule with untracked content
// is the real-world case) must not become a failed commit: the caller
// force-removes this worktree the moment this throws, so a throw here over
// there being nothing to commit would destroy work over a non-problem.
test("commitWorktreeChanges makes no commit, and does not throw, when nothing is staged", () => {
  const repo = makeFixtureRepo();
  const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

  commitWorktreeChanges(repo, "fabrica: task-1");

  const after = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  assert.equal(after, before);
});
