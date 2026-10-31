// Placing a task's files in a workstation and taking them away again -
// and the load-bearing claim behind the whole design, measured against
// real git rather than reasoned about: a folder holding a `.gitignore`
// of `*` is invisible to `git status`, `git add -A` and `git ls-files`,
// its own `.gitignore` included.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachedError } from "./errors.ts";
import { ATTACHED_FOLDER, IGNORE_FILE, attachedFolderPath, placeAttachedFiles, removeAttachedFiles } from "./place.ts";
import { resolveAttachedFiles } from "./resolve.ts";

/** A throwaway folder holding the named files, and the resolved list of
 * them this module takes as input. */
function sourceFiles(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-attached-source-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return { dir, files: resolveAttachedFiles(Object.keys(files).map((name) => join(dir, name))) };
}

/** A throwaway git repository with one commit, standing in for the
 * workstation a ProductionLine hands a machine. */
function makeWorkdir(): string {
  const workdir = mkdtempSync(join(tmpdir(), "fabrica-attached-workdir-"));
  const git = (...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...args], { cwd: workdir, encoding: "utf8" });
  git("init", "-q", ".");
  writeFileSync(join(workdir, "kept.txt"), "already here\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  return workdir;
}

function git(workdir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...args], {
    cwd: workdir,
    encoding: "utf8",
  });
}

test("placeAttachedFiles: nothing at all for a task handed no files", () => {
  const workdir = makeWorkdir();
  placeAttachedFiles(workdir, []);
  assert.equal(existsSync(attachedFolderPath(workdir)), false, "it created the folder anyway");
});

test("placeAttachedFiles: each file's bytes, under its bare name, in the fixed subfolder", () => {
  const workdir = makeWorkdir();
  const { files } = sourceFiles({ "pots.md": "the pots note\n", "data.csv": "a,b\n" });

  placeAttachedFiles(workdir, files);

  assert.equal(readFileSync(join(workdir, ATTACHED_FOLDER, "pots.md"), "utf8"), "the pots note\n");
  assert.equal(readFileSync(join(workdir, ATTACHED_FOLDER, "data.csv"), "utf8"), "a,b\n");
});

test("the fixed subfolder is invisible to git, its own .gitignore included", () => {
  const workdir = makeWorkdir();
  const { files } = sourceFiles({ "pots.md": "the pots note\n" });

  placeAttachedFiles(workdir, files);

  assert.equal(git(workdir, "status", "--porcelain").trim(), "", "git saw the folder");
  git(workdir, "add", "-A");
  assert.equal(git(workdir, "status", "--porcelain").trim(), "", "`git add -A` staged something from it");
  const tracked = git(workdir, "ls-files").trim().split("\n");
  assert.deepEqual(tracked, ["kept.txt"], "something from the folder became tracked");
  // Named explicitly, because this is the half that is easy to get
  // wrong: a `.gitignore` of `*` has to ignore itself too, or git
  // reports one untracked file forever.
  assert.ok(
    git(workdir, "check-ignore", "-v", join(ATTACHED_FOLDER, IGNORE_FILE)).includes(IGNORE_FILE),
    "the ignore file does not ignore itself"
  );
});

test("a commit of the whole worktree carries nothing of the task's files", () => {
  const workdir = makeWorkdir();
  const { files } = sourceFiles({ "pots.md": "the pots note\n" });

  placeAttachedFiles(workdir, files);
  writeFileSync(join(workdir, "work.txt"), "the machine's own change\n");
  git(workdir, "add", "-A");
  git(workdir, "commit", "-qm", "work");

  const committed = git(workdir, "show", "--name-only", "--format=", "HEAD").trim().split("\n");
  assert.deepEqual(committed, ["work.txt"]);
});

test("removeAttachedFiles: takes the folder away and leaves the rest alone", () => {
  const workdir = makeWorkdir();
  const { files } = sourceFiles({ "pots.md": "the pots note\n" });

  placeAttachedFiles(workdir, files);
  removeAttachedFiles(workdir);

  assert.equal(existsSync(attachedFolderPath(workdir)), false, "the folder is still there");
  assert.equal(existsSync(join(workdir, "kept.txt")), true, "it removed something else");
});

test("removeAttachedFiles: idempotent, and a no-op for a workstation that never had one", () => {
  const workdir = makeWorkdir();
  removeAttachedFiles(workdir);
  const { files } = sourceFiles({ "pots.md": "x" });
  placeAttachedFiles(workdir, files);
  removeAttachedFiles(workdir);
  removeAttachedFiles(workdir);
  assert.equal(existsSync(attachedFolderPath(workdir)), false);
});

test("removeAttachedFiles: a folder of the same name that is not Fabrica's is never deleted", () => {
  const workdir = makeWorkdir();
  const folder = attachedFolderPath(workdir);
  mkdirSync(folder);
  writeFileSync(join(folder, "theirs.txt"), "the project's own\n");

  removeAttachedFiles(workdir);

  assert.equal(readFileSync(join(folder, "theirs.txt"), "utf8"), "the project's own\n");
});

test("placeAttachedFiles: refuses a folder of the same name that is not Fabrica's", () => {
  const workdir = makeWorkdir();
  mkdirSync(attachedFolderPath(workdir));
  const { files } = sourceFiles({ "pots.md": "x" });

  assert.throws(
    () => placeAttachedFiles(workdir, files),
    (err: unknown) => {
      assert.ok(err instanceof AttachedError);
      assert.equal(err.code, "copy-failed");
      assert.ok(err.message.includes(ATTACHED_FOLDER), `did not name the folder: ${err.message}`);
      return true;
    }
  );
});

test("placeAttachedFiles: a file that has gone since is a copy-failed naming it", () => {
  const workdir = makeWorkdir();
  const { dir } = sourceFiles({});
  const gone = join(dir, "gone.md");

  assert.throws(
    () => placeAttachedFiles(workdir, [{ path: gone, name: "gone.md", bytes: 1 }]),
    (err: unknown) => {
      assert.ok(err instanceof AttachedError);
      assert.equal(err.code, "copy-failed");
      assert.ok(err.message.includes(gone), `did not name the file: ${err.message}`);
      return true;
    }
  );
});

test("placing twice over the same folder replaces the copies rather than refusing", () => {
  const workdir = makeWorkdir();
  const { dir, files } = sourceFiles({ "pots.md": "first\n" });

  placeAttachedFiles(workdir, files);
  writeFileSync(join(dir, "pots.md"), "corrected\n");
  placeAttachedFiles(workdir, resolveAttachedFiles([join(dir, "pots.md")]));

  assert.equal(readFileSync(join(workdir, ATTACHED_FOLDER, "pots.md"), "utf8"), "corrected\n");
});
