import { test } from "node:test";
import assert from "node:assert/strict";
import { realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createProductionLine, destroyProductionLine, LineError } from "./index.ts";
import { resolveCommonGitDir } from "./worktree-git.ts";
import { makeFixtureHome, makeFixtureProject } from "./helpers/fixture.ts";
import { runContained } from "../containment/index.ts";

test("resolveCommonGitDir finds the real project's shared .git from a worktree's pointer file", () => {
  const project = makeFixtureProject();
  const recordHome = makeFixtureHome();
  const line = createProductionLine({ project, taskId: "worktree-git-1", recordHome });

  try {
    const commonGitDir = resolveCommonGitDir(line.workdir);
    assert.equal(commonGitDir, realpathSync(join(project, ".git")));
    // It's the real thing, not a guess: git itself agrees this is the
    // common dir for this worktree.
    const reportedByGit = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: line.workdir,
      encoding: "utf8",
    }).trim();
    assert.equal(realpathSync(reportedByGit), commonGitDir);
  } finally {
    destroyProductionLine(line);
  }
});

test("resolveCommonGitDir refuses a directory that isn't a git worktree", () => {
  const notAWorktree = makeFixtureHome();
  writeFileSync(join(notAWorktree, ".git"), "not a real pointer file\n");

  assert.throws(
    () => resolveCommonGitDir(notAWorktree),
    (err: unknown) => err instanceof LineError && err.code === "not-a-worktree"
  );
});

// The real proof this exists for (issue #44's git-in-containment fix,
// verified live before writing this): mounted read-only, the Client's
// real project history is genuinely readable to a contained process -
// git status and log both work - but genuinely not writable: a commit
// attempt fails outright, closing off any way for a contained Worker to
// land a commit on its own. Skips (never fails) when Docker isn't
// available, since it needs the real daemon to prove anything.
function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("a contained process can read git history through resolveCommonGitDir's mount, but cannot commit", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");

  const project = makeFixtureProject();
  const recordHome = makeFixtureHome();
  const line = createProductionLine({ project, taskId: "worktree-git-contained", recordHome });

  try {
    const commonGitDir = resolveCommonGitDir(line.workdir);

    const status = await runContained("status", [], {
      workdir: line.workdir,
      network: "denied",
      image: "alpine/git",
      readOnlyMounts: [commonGitDir],
    });
    assert.equal(status.exitCode, 0);
    assert.match(status.stdout, /nothing to commit, working tree clean/);

    const log = await runContained("log", ["--oneline"], {
      workdir: line.workdir,
      network: "denied",
      image: "alpine/git",
      readOnlyMounts: [commonGitDir],
    });
    assert.equal(log.exitCode, 0);
    assert.match(log.stdout, /init/, "real project history must be readable, not just the worktree's own tip");

    writeFileSync(join(line.workdir, "app.txt"), "a change from inside the container\n");
    const commit = await runContained(
      "-c",
      ["user.email=w@w", "-c", "user.name=w", "commit", "-am", "should be impossible"],
      { workdir: line.workdir, network: "denied", image: "alpine/git", readOnlyMounts: [commonGitDir] }
    );
    assert.notEqual(commit.exitCode, 0, "a contained process must not be able to commit");
    assert.match(commit.stderr, /read-only file system/i);
  } finally {
    destroyProductionLine(line);
  }
});
