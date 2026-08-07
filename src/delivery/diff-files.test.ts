import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { diffFiles } from "./diff-files.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";

function commitAll(cwd: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", message], { cwd });
}

// Mirrors how the real system branches: a linked worktree on a new branch,
// project's own checkout (and its HEAD) left exactly where it was — never
// `git checkout` inside `project` itself.
function addWorktree(project: string, branch: string): string {
  const workdir = join(project, "..", "wt-" + Math.random().toString(36).slice(2));
  execFileSync("git", ["worktree", "add", "-b", branch, workdir, "HEAD"], { cwd: project });
  return workdir;
}

test("diffFiles lists what a branch changed relative to its fork point", () => {
  const project = makeFixtureRepo();
  const workdir = addWorktree(project, "feature");
  writeFileSync(join(workdir, "app.txt"), "changed\n");
  writeFileSync(join(workdir, "new-file.txt"), "new\n");
  commitAll(workdir, "work");

  assert.deepEqual(diffFiles(project, "feature").sort(), ["app.txt", "new-file.txt"]);
});

test("diffFiles keeps only the new path for a rename, like git status does", () => {
  const project = makeFixtureRepo();
  const workdir = addWorktree(project, "feature");
  execFileSync("git", ["mv", "app.txt", "renamed.txt"], { cwd: workdir });
  commitAll(workdir, "rename");

  assert.deepEqual(diffFiles(project, "feature"), ["renamed.txt"]);
});

test("diffFiles is empty for a branch with no commits beyond its fork point", () => {
  const project = makeFixtureRepo();
  addWorktree(project, "feature");

  assert.deepEqual(diffFiles(project, "feature"), []);
});

test("diffFiles still works after the branch's worktree is gone, reading from the repo alone", () => {
  const project = makeFixtureRepo();
  const workdir = addWorktree(project, "feature");
  writeFileSync(join(workdir, "extra.txt"), "extra\n");
  commitAll(workdir, "work");
  execFileSync("git", ["worktree", "remove", "--force", workdir], { cwd: project });

  assert.deepEqual(diffFiles(project, "feature"), ["extra.txt"]);
});
