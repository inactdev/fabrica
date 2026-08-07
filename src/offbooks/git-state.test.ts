import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { filesChangedBetween, pathFromPorcelainLine, readProjectGitState } from "./git-state.ts";

test("readProjectGitState: a clean checkout has an empty dirty list", () => {
  const repo = makeFixtureRepo();
  const state = readProjectGitState(repo);
  assert.ok(state);
  assert.deepEqual(state.dirty, []);
  assert.match(state.headCommit, /^[0-9a-f]{40}$/);
});

test("readProjectGitState: an edited tracked file shows up as dirty", () => {
  const repo = makeFixtureRepo();
  writeFileSync(join(repo, "app.txt"), "edited by hand\n");
  const state = readProjectGitState(repo);
  assert.equal(state?.dirty.length, 1);
  assert.equal(pathFromPorcelainLine(state.dirty[0]), "app.txt");
});

test("readProjectGitState: a gitignored file never shows up as dirty", () => {
  const repo = makeFixtureRepo();
  writeFileSync(join(repo, ".gitignore"), "build/\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "gitignore"], { cwd: repo });

  mkdirSync(join(repo, "build"));
  writeFileSync(join(repo, "build", "artifact.js"), "// built\n");

  const state = readProjectGitState(repo);
  assert.deepEqual(state?.dirty, []);
});

test("readProjectGitState: an untracked, non-ignored file shows up as dirty", () => {
  const repo = makeFixtureRepo();
  writeFileSync(join(repo, "new-file.txt"), "surprise\n");
  const state = readProjectGitState(repo);
  assert.equal(state?.dirty.length, 1);
  assert.equal(pathFromPorcelainLine(state.dirty[0]), "new-file.txt");
});

test("readProjectGitState: a path that isn't a git repo at all reads as null, not a throw", () => {
  assert.equal(readProjectGitState("/definitely/not/a/real/path/anywhere"), null);
});

test("readProjectGitState: reports the current branch name", () => {
  const repo = makeFixtureRepo();
  const state = readProjectGitState(repo);
  const realBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  assert.equal(state?.branch, realBranch);
});

test("pathFromPorcelainLine: plain modified/untracked lines", () => {
  assert.equal(pathFromPorcelainLine(" M app.txt"), "app.txt");
  assert.equal(pathFromPorcelainLine("?? new-file.txt"), "new-file.txt");
});

test("pathFromPorcelainLine: a rename line reports the new name", () => {
  assert.equal(pathFromPorcelainLine("R  old.txt -> new.txt"), "new.txt");
});

test("filesChangedBetween: lists files touched by real commits", () => {
  const repo = makeFixtureRepo();
  const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

  writeFileSync(join(repo, "app.txt"), "changed\n");
  writeFileSync(join(repo, "second.txt"), "new\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "second commit"], {
    cwd: repo,
  });
  const after = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

  const files = filesChangedBetween(repo, before, after);
  assert.deepEqual(files.sort(), ["app.txt", "second.txt"]);
});

test("filesChangedBetween: an unreachable old commit resolves to an empty list, never throws", () => {
  const repo = makeFixtureRepo();
  assert.deepEqual(filesChangedBetween(repo, "0000000000000000000000000000000000000000", "HEAD"), []);
});
