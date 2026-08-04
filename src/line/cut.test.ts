import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { cutLine } from "./cut.ts";
import { LineError } from "./errors.ts";
import { fingerprint, makeFixtureHome, makeFixtureProject } from "./helpers/fixture.ts";

test("cutLine creates a linked worktree on branch fabrica/<id> with the project's content", () => {
  const project = makeFixtureProject();
  const home = makeFixtureHome();

  const line = cutLine({ project, id: "task-abc", home });

  assert.equal(line.branch, "fabrica/task-abc");
  // Compare against line.home, not the raw `home` passed in: on macOS
  // tmpdir() lives under a /var -> /private/var symlink, and only the
  // realpath'd value cutLine returns is authoritative for path comparisons.
  assert.equal(line.workdir, join(line.home, "tasks", "task-abc", "worktree"));
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

test("cutLine never modifies the Client's checkout", () => {
  const project = makeFixtureProject();
  const home = makeFixtureHome();
  const before = fingerprint(project);

  cutLine({ project, id: "task-fp", home });

  assert.equal(fingerprint(project), before);
});

test("cutLine rejects unsafe ids", () => {
  const project = makeFixtureProject();
  const home = makeFixtureHome();

  for (const id of ["", "../evil", "a/b", "a b", ".."]) {
    assert.throws(
      () => cutLine({ project, id, home }),
      (err: unknown) => err instanceof LineError && err.code === "invalid-id"
    );
  }
});

test("cutLine refuses a project path that is not a git repository", () => {
  const notARepo = mkdtempSync(join(tmpdir(), "fabrica-line-not-a-repo-"));
  const home = makeFixtureHome();

  assert.throws(
    () => cutLine({ project: notARepo, id: "task-x", home }),
    (err: unknown) => err instanceof LineError && err.code === "not-a-repo"
  );
});

test("cutLine refuses a path that is a subdirectory of a repo, not its root", () => {
  const project = makeFixtureProject();
  const home = makeFixtureHome();
  const subdir = join(project, "subdir");
  mkdirSync(subdir);

  assert.throws(
    () => cutLine({ project: subdir, id: "task-x", home }),
    (err: unknown) => err instanceof LineError && err.code === "not-a-repo"
  );
});

test("cutLine refuses to reuse a task id whose workspace already exists", () => {
  const project = makeFixtureProject();
  const home = makeFixtureHome();

  cutLine({ project, id: "task-dup", home });

  assert.throws(
    () => cutLine({ project, id: "task-dup", home }),
    (err: unknown) => err instanceof LineError && err.code === "workdir-exists"
  );
});
