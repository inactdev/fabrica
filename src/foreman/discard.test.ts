import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureDiscardedPatch } from "./discard.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";

function headOf(repo: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
}

test("captureDiscardedPatch covers worker commits, uncommitted edits, and binary files, without moving the branch", () => {
  const repo = makeFixtureRepo();
  const baseCommit = headOf(repo);

  // A worker with git access may commit some of its work itself...
  writeFileSync(join(repo, "app.txt"), "changed and committed by the worker\n");
  execSync("git add -A && git -c user.email=w@w -c user.name=w commit -qm worker-commit", {
    cwd: repo,
    shell: "/bin/bash",
  });
  const headBefore = headOf(repo);
  // ...and leave the rest uncommitted, including a new file and a binary.
  writeFileSync(join(repo, "new-file.txt"), "new and uncommitted\n");
  writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 255, 254, 0, 10, 13]));

  const patch = captureDiscardedPatch(repo, baseCommit);

  assert.ok(patch.includes("app.txt"), "the worker's committed change is missing from the patch");
  assert.ok(patch.includes("new-file.txt"), "the uncommitted new file is missing from the patch");
  assert.ok(patch.includes("blob.bin"), "the binary file is missing from the patch");
  assert.ok(
    !patch.includes("Binary files"),
    "the binary file is only a stub — the patch must carry its content (--binary)"
  );
  assert.ok(patch.includes("GIT binary patch"), "no self-contained binary section in the patch");
  assert.equal(headOf(repo), headBefore, "captureDiscardedPatch must never move the branch itself");

  // The whole point of the patch is that git apply can pick the work back
  // up — prove it against a fresh checkout of the same base content.
  const fresh = makeFixtureRepo();
  execFileSync("git", ["apply", "--check"], { cwd: fresh, input: patch });
});

test("captureDiscardedPatch returns an empty string when nothing changed since the base commit", () => {
  const repo = makeFixtureRepo();
  assert.equal(captureDiscardedPatch(repo, headOf(repo)), "");
});
