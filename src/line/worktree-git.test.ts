import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { createProductionLine, destroyProductionLine, LineError } from "./index.ts";
import { resolveCommonGitDir, writeSanitizedGitConfig } from "./worktree-git.ts";
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

test("resolveCommonGitDir resolves a relative gitdir pointer against the workdir, not the process cwd", () => {
  // git 2.48+ writes a relative gitdir when worktree.useRelativePaths or
  // extensions.relativeWorktrees is configured - same layout as a real
  // worktree, just with relative paths in both pointer files.
  const base = makeFixtureHome();
  const workdir = join(base, "workdir");
  const projectGitDir = join(base, "project", ".git");
  const worktreeGitDir = join(projectGitDir, "worktrees", "t1");
  mkdirSync(workdir, { recursive: true });
  mkdirSync(worktreeGitDir, { recursive: true });
  writeFileSync(join(workdir, ".git"), "gitdir: ../project/.git/worktrees/t1\n");
  writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");

  assert.equal(resolveCommonGitDir(workdir), realpathSync(projectGitDir));
});

test("writeSanitizedGitConfig copies forward the [core] section and drops every non-allowlisted section", () => {
  const gitDir = makeFixtureHome();
  // Every config-based credential mechanism review has surfaced so far,
  // plus git's deprecated dotted section syntax - and one benign
  // non-core section ([branch]) proving the allowlist drops the
  // unrecognized-but-harmless too, not just the known-bad.
  writeFileSync(
    join(gitDir, "config"),
    [
      "[core]",
      "\trepositoryformatversion = 0",
      "\tfilemode = true",
      '[remote "origin"]',
      "\turl = https://x-token:FAKE_CREDENTIAL@example.invalid/repo.git",
      "\tfetch = +refs/heads/*:refs/remotes/origin/*",
      "[remote.upstream]",
      "\turl = https://x-token:FAKE_DOTTED_CREDENTIAL@example.invalid/repo.git",
      '[http "https://example.invalid"]',
      "\textraheader = AUTHORIZATION: basic FAKE_BASIC_TOKEN",
      '[url "https://x-token:FAKE_REWRITE_CREDENTIAL@example.invalid/"]',
      "\tinsteadOf = https://example.invalid/",
      "[credential]",
      "\thelper = store",
      "[include]",
      "\tpath = ../elsewhere.inc",
      '[branch "main"]',
      "\tremote = origin",
      "",
    ].join("\n")
  );

  const sanitizedPath = writeSanitizedGitConfig(gitDir);
  try {
    const sanitized = readFileSync(sanitizedPath, "utf8");
    const lines = sanitized.split("\n").filter((line) => line.trim() !== "");
    assert.deepEqual(
      lines,
      ["[core]", "\trepositoryformatversion = 0", "\tfilemode = true"],
      "the sanitized config must contain the [core] section's lines and nothing else at all"
    );
  } finally {
    rmSync(dirname(sanitizedPath), { recursive: true, force: true });
  }
});

test("writeSanitizedGitConfig forwards allowlisted [extensions] keys, so the container's git reads the repo correctly", () => {
  const gitDir = makeFixtureHome();
  writeFileSync(
    join(gitDir, "config"),
    [
      "[core]",
      "\trepositoryformatversion = 1",
      "[extensions]",
      "\tobjectFormat = sha256",
      "\trefStorage = reftable",
      "\trelativeWorktrees = true",
      '[remote "origin"]',
      "\turl = https://x-token:FAKE_CREDENTIAL@example.invalid/repo.git",
      "",
    ].join("\n")
  );

  const sanitizedPath = writeSanitizedGitConfig(gitDir);
  try {
    const lines = readFileSync(sanitizedPath, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    assert.deepEqual(
      lines,
      [
        "[core]",
        "\trepositoryformatversion = 1",
        "[extensions]",
        "\tobjectFormat = sha256",
        "\trefStorage = reftable",
        "\trelativeWorktrees = true",
      ],
      "structural extension keys must survive sanitization, and nothing else may"
    );
  } finally {
    rmSync(dirname(sanitizedPath), { recursive: true, force: true });
  }
});

test("writeSanitizedGitConfig refuses an [extensions] key not on its allowlist, naming it - never silently drops it", () => {
  const gitDir = makeFixtureHome();
  // worktreeConfig is a real, documented extension that is deliberately
  // off the allowlist: forwarding it would make git honor an
  // unsanitized config.worktree file inside the mount.
  writeFileSync(
    join(gitDir, "config"),
    ["[core]", "\trepositoryformatversion = 1", "[extensions]", "\tworktreeConfig = true", ""].join("\n")
  );

  assert.throws(
    () => writeSanitizedGitConfig(gitDir),
    (err: unknown) =>
      err instanceof LineError &&
      err.code === "unsanitizable-config" &&
      err.message.includes("extensions.worktreeConfig")
  );
});

test("writeSanitizedGitConfig refuses a URI-form refStorage value, whose payload names a host location", () => {
  const gitDir = makeFixtureHome();
  writeFileSync(
    join(gitDir, "config"),
    ["[core]", "\trepositoryformatversion = 1", "[extensions]", "\trefStorage = reftable:///on/the/host", ""].join("\n")
  );

  assert.throws(
    () => writeSanitizedGitConfig(gitDir),
    (err: unknown) =>
      err instanceof LineError && err.code === "unsanitizable-config" && err.message.includes("refStorage")
  );
});

test("resolveCommonGitDir refuses a directory that isn't a git worktree", () => {
  const notAWorktree = makeFixtureHome();
  writeFileSync(join(notAWorktree, ".git"), "not a real pointer file\n");

  assert.throws(
    () => resolveCommonGitDir(notAWorktree),
    (err: unknown) => err instanceof LineError && err.code === "not-a-worktree"
  );
});

test("resolveCommonGitDir refuses a worktree whose commondir names a since-deleted directory", () => {
  const workdir = makeFixtureHome();
  const worktreeGitDir = join(workdir, "worktree-git-dir");
  mkdirSync(worktreeGitDir);
  writeFileSync(join(workdir, ".git"), `gitdir: ${worktreeGitDir}\n`);
  writeFileSync(join(worktreeGitDir, "commondir"), join(workdir, "since-deleted-project", ".git") + "\n");

  assert.throws(
    () => resolveCommonGitDir(workdir),
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

// The credential-exposure proof: the shared .git's `config` can carry a
// remote URL with an embedded credential, and a contained process must
// never be able to read it - while git itself keeps working through the
// sanitized shadow-mounted copy. Verified against the real daemon.
test("a sanitized config shadow-mount keeps git working but hides remote URLs and credentials", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");

  const project = makeFixtureProject();
  const fakeCredential = "FAKE_EMBEDDED_CREDENTIAL";
  execFileSync("git", ["remote", "add", "origin", `https://x-token:${fakeCredential}@example.invalid/repo.git`], {
    cwd: project,
  });
  const recordHome = makeFixtureHome();
  const line = createProductionLine({ project, taskId: "worktree-git-sanitized", recordHome });

  try {
    const commonGitDir = resolveCommonGitDir(line.workdir);
    const sanitizedConfig = writeSanitizedGitConfig(commonGitDir);
    try {
      const readOnlyMounts = [
        commonGitDir,
        { source: sanitizedConfig, target: join(commonGitDir, "config") },
      ];
      const gitOpts = { workdir: line.workdir, network: "denied" as const, image: "alpine/git", readOnlyMounts };

      const status = await runContained("status", [], gitOpts);
      assert.equal(status.exitCode, 0);
      assert.match(status.stdout, /nothing to commit, working tree clean/);

      const log = await runContained("log", ["--oneline"], gitOpts);
      assert.equal(log.exitCode, 0);
      assert.match(log.stdout, /init/);

      const diff = await runContained("diff", [], gitOpts);
      assert.equal(diff.exitCode, 0);

      // The remote the host genuinely has configured is simply not there
      // inside the container - not readable through git itself...
      const remoteUrl = await runContained("config", ["--get", "remote.origin.url"], gitOpts);
      assert.notEqual(remoteUrl.exitCode, 0, "no remote URL may be readable inside the container");
      assert.equal(remoteUrl.stdout.trim(), "");

      // ...and not by reading the config file directly either: the file
      // at the real config's path is the sanitized copy, remote-free.
      const rawConfig = await runContained("cat", [join(commonGitDir, "config")], {
        workdir: line.workdir,
        network: "denied",
        image: "alpine",
        readOnlyMounts,
      });
      assert.equal(rawConfig.exitCode, 0);
      assert.ok(!rawConfig.stdout.includes("[remote"), "the config visible inside must have no remote section");

      for (const result of [status, log, diff, remoteUrl, rawConfig]) {
        assert.ok(!result.stdout.includes(fakeCredential), "the credential must never appear in any output");
        assert.ok(!result.stderr.includes(fakeCredential), "the credential must never appear in any output");
      }
    } finally {
      rmSync(dirname(sanitizedConfig), { recursive: true, force: true });
    }
  } finally {
    destroyProductionLine(line);
  }
});
