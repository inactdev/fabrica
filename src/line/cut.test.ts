import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createProductionLine } from "./cut.ts";
import { LineError } from "./errors.ts";
import { fingerprint, makeFixtureHome, makeFixtureProject } from "./helpers/fixture.ts";

test("createProductionLine creates a linked worktree on branch fabrica/<taskId> with the project's content", () => {
  const project = makeFixtureProject();
  const recordHome = makeFixtureHome();

  const line = createProductionLine({ project, taskId: "task-abc", recordHome });

  assert.equal(line.branch, "fabrica/task-abc");
  // Compare against line.recordHome, not the raw `recordHome` passed in: on
  // macOS tmpdir() lives under a /var -> /private/var symlink, and only the
  // realpath'd value createProductionLine returns is authoritative for path
  // comparisons.
  assert.equal(line.workdir, join(line.recordHome, "tasks", "task-abc", "worktree"));
  assert.ok(existsSync(line.workdir));
  assert.equal(
    readFileSync(join(line.workdir, "app.txt"), "utf8"),
    readFileSync(join(project, "app.txt"), "utf8")
  );

  const branches = execFileSync("git", ["branch", "--list", "fabrica/task-abc"], {
    cwd: project,
  }).toString();
  assert.match(branches, /fabrica\/task-abc/);
});

test("createProductionLine never modifies the Client's checkout", () => {
  const project = makeFixtureProject();
  const recordHome = makeFixtureHome();
  const before = fingerprint(project);

  createProductionLine({ project, taskId: "task-fp", recordHome });

  assert.equal(fingerprint(project), before);
});

test("createProductionLine rejects unsafe ids", () => {
  const project = makeFixtureProject();
  const recordHome = makeFixtureHome();

  for (const taskId of ["", "../evil", "a/b", "a b", ".."]) {
    assert.throws(
      () => createProductionLine({ project, taskId, recordHome }),
      (err: unknown) => err instanceof LineError && err.code === "invalid-id"
    );
  }
});

test("createProductionLine refuses a project path that is not a git repository", () => {
  const notARepo = mkdtempSync(join(tmpdir(), "fabrica-line-not-a-repo-"));
  const recordHome = makeFixtureHome();

  assert.throws(
    () => createProductionLine({ project: notARepo, taskId: "task-x", recordHome }),
    (err: unknown) => err instanceof LineError && err.code === "not-a-repo"
  );
});

test("createProductionLine refuses a path that is a subdirectory of a repo, not its root", () => {
  const project = makeFixtureProject();
  const recordHome = makeFixtureHome();
  const subdir = join(project, "subdir");
  mkdirSync(subdir);

  assert.throws(
    () => createProductionLine({ project: subdir, taskId: "task-x", recordHome }),
    (err: unknown) => err instanceof LineError && err.code === "not-a-repo"
  );
});

test("createProductionLine refuses to reuse a task id whose workspace already exists", () => {
  const project = makeFixtureProject();
  const recordHome = makeFixtureHome();

  createProductionLine({ project, taskId: "task-dup", recordHome });

  assert.throws(
    () => createProductionLine({ project, taskId: "task-dup", recordHome }),
    (err: unknown) => err instanceof LineError && err.code === "workdir-exists"
  );
});
