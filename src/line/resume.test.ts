import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createProductionLine } from "./cut.ts";
import { reopenProductionLine } from "./resume.ts";
import { destroyProductionLine } from "./teardown.ts";
import { LineError } from "./errors.ts";
import { makeFixtureHome, makeFixtureProject } from "./helpers/fixture.ts";

test("reopenProductionLine checks out the branch a prior createProductionLine committed to, at the same workdir path", () => {
  const project = makeFixtureProject();
  const recordHome = makeFixtureHome();

  const first = createProductionLine({ project, taskId: "task-resume", recordHome });
  writeFileSync(join(first.workdir, "app.txt"), "changed by the first round\n");
  execFileSync("git", ["add", "-A"], { cwd: first.workdir });
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "first round"],
    { cwd: first.workdir }
  );
  destroyProductionLine(first);
  assert.ok(!existsSync(first.workdir), "teardown must actually remove the worktree before reopening");

  const reopened = reopenProductionLine({ project, taskId: "task-resume", recordHome });

  assert.equal(reopened.branch, "fabrica/task-resume");
  assert.equal(reopened.workdir, first.workdir, "the fix path needs the identical cwd for session resume");
  assert.equal(
    readFileSync(join(reopened.workdir, "app.txt"), "utf8"),
    "changed by the first round\n",
    "reopening must see the first round's commit, not a clean checkout of the project's own HEAD"
  );
});

test("reopenProductionLine refuses a task id whose branch was never cut", () => {
  const project = makeFixtureProject();
  const recordHome = makeFixtureHome();

  assert.throws(
    () => reopenProductionLine({ project, taskId: "task-never-run", recordHome }),
    (err: unknown) => err instanceof LineError && err.code === "no-such-branch"
  );
});

test("reopenProductionLine refuses a tag that carries the branch's name but no branch", () => {
  const project = makeFixtureProject();
  const recordHome = makeFixtureHome();
  execFileSync("git", ["tag", "fabrica/task-tag-only"], { cwd: project });

  assert.throws(
    () => reopenProductionLine({ project, taskId: "task-tag-only", recordHome }),
    (err: unknown) => err instanceof LineError && err.code === "no-such-branch"
  );
});

test("reopenProductionLine stays on the branch when a tag shares its name", () => {
  const project = makeFixtureProject();
  const recordHome = makeFixtureHome();

  const first = createProductionLine({ project, taskId: "task-shadowed", recordHome });
  writeFileSync(join(first.workdir, "app.txt"), "changed by the first round\n");
  execFileSync("git", ["add", "-A"], { cwd: first.workdir });
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "first round"],
    { cwd: first.workdir }
  );
  destroyProductionLine(first);
  execFileSync("git", ["tag", "fabrica/task-shadowed", "HEAD"], { cwd: project });

  const reopened = reopenProductionLine({ project, taskId: "task-shadowed", recordHome });

  assert.equal(
    execFileSync("git", ["symbolic-ref", "HEAD"], { cwd: reopened.workdir, encoding: "utf8" }).trim(),
    "refs/heads/fabrica/task-shadowed",
    "a detached HEAD here would silently orphan the fix round's commits"
  );
});

/** Runs a first round for `taskId`, commits on its branch, and tears the
 * line down - leaving exactly what a fix round would reopen: the branch
 * `fabrica/<taskId>`, and no worktree holding it. */
function roundOne(project: string, recordHome: string, taskId: string): string {
  const first = createProductionLine({ project, taskId, recordHome });
  writeFileSync(join(first.workdir, "app.txt"), "changed by the first round\n");
  execFileSync("git", ["add", "-A"], { cwd: first.workdir });
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "first round"],
    { cwd: first.workdir }
  );
  destroyProductionLine(first);
  return first.branch;
}

test("reopenProductionLine says plainly that the task's branch is checked out in the project folder", () => {
  const project = makeFixtureProject();
  const recordHome = makeFixtureHome();
  roundOne(project, recordHome, "task-on-the-client-s-desk");
  // What the Client does to read a Worker's work by hand.
  execFileSync("git", ["checkout", "-q", "fabrica/task-on-the-client-s-desk"], { cwd: project });

  assert.throws(
    () => reopenProductionLine({ project, taskId: "task-on-the-client-s-desk", recordHome }),
    (err: unknown) => {
      assert.ok(err instanceof LineError);
      assert.equal(err.code, "branch-checked-out");
      assert.equal(
        err.message,
        `Cannot reopen a ProductionLine for fabrica/task-on-the-client-s-desk: the project's own ` +
          `checkout at ${realpathSync(project)} is on that branch right now, and git cannot check one ` +
          `branch out in two places. Switch that checkout to another branch and try again.`
      );
      return true;
    }
  );

  assert.ok(
    !existsSync(join(recordHome, "tasks", "task-on-the-client-s-desk", "worktree")),
    "the refusal must land before any worktree is created"
  );
});

test("reopenProductionLine names the other worktree when one outside the project folder holds the branch", () => {
  const project = makeFixtureProject();
  const recordHome = makeFixtureHome();
  const branch = roundOne(project, recordHome, "task-held-elsewhere");
  const elsewhere = join(makeFixtureHome(), "by-hand");
  execFileSync("git", ["worktree", "add", "-q", elsewhere, branch], { cwd: project });

  assert.throws(
    () => reopenProductionLine({ project, taskId: "task-held-elsewhere", recordHome }),
    (err: unknown) => {
      assert.ok(err instanceof LineError);
      assert.equal(err.code, "branch-checked-out");
      assert.equal(
        err.message,
        `Cannot reopen a ProductionLine for fabrica/task-held-elsewhere: another worktree of ` +
          `${realpathSync(project)} has that branch checked out, at ${realpathSync(elsewhere)}, and ` +
          `git cannot check one branch out in two places. Remove that worktree or switch it to ` +
          `another branch, then try again.`
      );
      return true;
    }
  );
});

test("reopenProductionLine refuses when a workspace already exists at that path", () => {
  const project = makeFixtureProject();
  const recordHome = makeFixtureHome();
  createProductionLine({ project, taskId: "task-still-open", recordHome });

  assert.throws(
    () => reopenProductionLine({ project, taskId: "task-still-open", recordHome }),
    (err: unknown) => err instanceof LineError && err.code === "workdir-exists"
  );
});
