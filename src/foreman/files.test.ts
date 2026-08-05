import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { listTouchedFiles } from "./files.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";

test("listTouchedFiles returns exact paths for non-ASCII and quote-bearing names", () => {
  const repo = makeFixtureRepo();
  writeFileSync(join(repo, "café.txt"), "non-ascii\n");
  writeFileSync(join(repo, 'has "quotes".txt'), "quoted\n");

  assert.deepEqual(listTouchedFiles(repo).sort(), ["café.txt", 'has "quotes".txt'].sort());
});

test("listTouchedFiles keeps only the new path for a staged rename", () => {
  const repo = makeFixtureRepo();
  execSync("git mv app.txt renamed.txt", { cwd: repo });
  writeFileSync(join(repo, "extra.txt"), "extra\n");

  assert.deepEqual(listTouchedFiles(repo).sort(), ["extra.txt", "renamed.txt"]);
});

test("listTouchedFiles covers staged, unstaged, and untracked changes", () => {
  const repo = makeFixtureRepo();
  writeFileSync(join(repo, "app.txt"), "unstaged edit\n");
  writeFileSync(join(repo, "staged.txt"), "staged\n");
  execSync("git add staged.txt", { cwd: repo });
  writeFileSync(join(repo, "untracked.txt"), "untracked\n");

  assert.deepEqual(listTouchedFiles(repo).sort(), ["app.txt", "staged.txt", "untracked.txt"]);
});
