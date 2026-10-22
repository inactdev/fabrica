// Which way round two commits are. These run real `git` against a real
// repository created here, so they prove the actual
// fetch-and-merge-base mechanism rather than a model of it - and they
// never reach the network, since the "remote" is a local path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAncestry } from "./ancestry.ts";

/** A real repository with a real main and a real unmerged branch. */
function fixtureRepo(): { path: string; mainTip: string; olderOnMain: string; offBranch: string } {
  const path = mkdtempSync(join(tmpdir(), "fabrica-inspector-main-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: path,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" },
    }).trim();

  git("init", "-q", "-b", "main");
  const commit = (message: string) => {
    git("commit", "-q", "--allow-empty", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const olderOnMain = commit("one");
  git("branch", "side");
  const mainTip = commit("two");
  git("checkout", "-q", "side");
  const offBranch = commit("off to one side");
  git("checkout", "-q", "main");
  return { path, mainTip, olderOnMain, offBranch };
}

test("commitAncestry: a commit in main's history is behind it, abbreviated or not", () => {
  const repo = fixtureRepo();
  assert.equal(commitAncestry(repo.olderOnMain, { repoUrl: repo.path }), "behind");
  assert.equal(commitAncestry(repo.olderOnMain.slice(0, 12), { repoUrl: repo.path }), "behind");
});

// git calls every commit its own ancestor, so this is the one answer
// `merge-base --is-ancestor` alone gets wrong. Callers never ask about
// the tip - `inspectorVersionCheck` settles that case before any fetch -
// but an answer that is wrong for one input is a trap for the next
// caller, so the tip is ruled out inside the probe itself.
test("commitAncestry: main's own tip is not behind main", () => {
  const repo = fixtureRepo();
  assert.equal(commitAncestry(repo.mainTip, { repoUrl: repo.path }), "not-behind");
  assert.equal(commitAncestry(repo.mainTip.slice(0, 12), { repoUrl: repo.path }), "not-behind");
});

test("commitAncestry: a commit on a branch main never took is not behind it", () => {
  const repo = fixtureRepo();
  assert.equal(commitAncestry(repo.offBranch, { repoUrl: repo.path }), "not-behind");
});

test("commitAncestry: a commit no history knows is not behind main, not an error", () => {
  const repo = fixtureRepo();
  assert.equal(commitAncestry("deadbeefdead", { repoUrl: repo.path }), "not-behind");
});

test("commitAncestry: a repository that cannot be reached is unknown, never behind", () => {
  assert.equal(commitAncestry("deadbeefdead", { repoUrl: join(tmpdir(), "fabrica-no-such-repo-ever") }), "unknown");
});

test("commitAncestry: the branch asked about is the one measured, not whatever HEAD is", () => {
  const repo = fixtureRepo();
  // `side` carries both main's first commit and its own tip, so the
  // same two commits answer differently depending on the ref asked for.
  assert.equal(commitAncestry(repo.offBranch, { repoUrl: repo.path, ref: "side" }), "not-behind");
  assert.equal(commitAncestry(repo.olderOnMain, { repoUrl: repo.path, ref: "side" }), "behind");
  assert.equal(commitAncestry(repo.mainTip, { repoUrl: repo.path, ref: "side" }), "not-behind");
});
