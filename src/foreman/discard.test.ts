import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureDiscardedPatch } from "./discard.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";

test("captureDiscardedPatch returns a patch covering modified and new files, without ever committing", () => {
  const repo = makeFixtureRepo();
  const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  writeFileSync(join(repo, "app.txt"), "changed\n");
  writeFileSync(join(repo, "new-file.txt"), "new\n");

  const patch = captureDiscardedPatch(repo);

  assert.ok(patch.includes("app.txt"), "the modified file is missing from the patch");
  assert.ok(patch.includes("new-file.txt"), "the new file is missing from the patch");
  const headAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  assert.equal(headAfter, headBefore, "captureDiscardedPatch must never create a commit");
});

test("captureDiscardedPatch returns an empty string when nothing changed", () => {
  const repo = makeFixtureRepo();
  assert.equal(captureDiscardedPatch(repo), "");
});
