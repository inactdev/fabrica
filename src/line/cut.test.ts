import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

test("createProductionLine cuts a new task's branch from origin's default branch, never the local checkout's HEAD", () => {
  const project = makeFixtureProject();
  const recordHome = makeFixtureHome();

  // "The local master is behind origin": advance origin two commits ahead
  // through a second clone, so nothing in `project` itself ever changes.
  const originUrl = execFileSync("git", ["remote", "get-url", "origin"], { cwd: project, encoding: "utf8" }).trim();
  const branch = execFileSync("git", ["branch", "--show-current"], { cwd: project, encoding: "utf8" }).trim();
  const mirror = mkdtempSync(join(tmpdir(), "fabrica-line-mirror-"));
  execFileSync("git", ["clone", "-q", originUrl, mirror]);
  for (const message of ["upstream 1", "upstream 2"]) {
    writeFileSync(join(mirror, "upstream.txt"), `${message}\n`);
    execFileSync("git", ["add", "-A"], { cwd: mirror });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", message], { cwd: mirror });
  }
  execFileSync("git", ["push", "-q", "origin", branch], { cwd: mirror });

  const before = fingerprint(project);
  const line = createProductionLine({ project, taskId: "task-origin", recordHome });

  assert.equal(
    readFileSync(join(line.workdir, "upstream.txt"), "utf8"),
    "upstream 2\n",
    "the line should be cut from origin's latest commit, not the local checkout's HEAD"
  );
  assert.equal(fingerprint(project), before, "the local checkout, two commits behind origin, must stay untouched");
});

test("createProductionLine refuses rather than falling back to the local checkout when origin can't be fetched", () => {
  const project = makeFixtureProject();
  const recordHome = makeFixtureHome();

  // Point "origin" at a path that doesn't exist - the fetch itself fails.
  execFileSync("git", ["remote", "set-url", "origin", join(recordHome, "no-such-remote")], { cwd: project });

  assert.throws(
    () => createProductionLine({ project, taskId: "task-fetch-fails", recordHome }),
    (err: unknown) => err instanceof LineError && err.code === "fetch-failed"
  );

  assert.ok(
    !existsSync(join(recordHome, "tasks", "task-fetch-fails")),
    "a failed fetch must refuse before starting anything - no task folder either"
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
