// The two git reads, against a real repository - the shapes git actually
// prints, not a model of them. `git diff --shortstat` and `git patch-id
// --stable` were verified by hand against git 2.54.0 while this was
// written; these tests are what keep that true on whatever git the
// project is checked out under next.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeCounts, changeFingerprint } from "./git.ts";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir, encoding: "utf8" });
}

/** A repository with a base commit and a `feat` branch holding the change
 * described by `files`. Returns the fork point and the branch name. */
function repoWithChange(files: Record<string, string>): { dir: string; base: string; branch: string } {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-skiprules-git-"));
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "intro.md"), "one\ntwo\nthree\n");
  git(dir, "init", "-q", ".");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  const base = git(dir, "rev-parse", "HEAD").trim();
  git(dir, "checkout", "-qb", "feat");
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "change");
  return { dir, base, branch: "feat" };
}

test("changeCounts reads files, insertions and deletions off one shortstat", () => {
  const { dir, base, branch } = repoWithChange({
    "docs/intro.md": "one\ntwo\nthree\nfour\n",
    "docs/extra.md": "a\nb\n",
  });
  assert.deepEqual(changeCounts(dir, base, branch), { files: 2, insertions: 3, deletions: 0 });
});

test("changeCounts reports a deletion-only change as deletions, not insertions", () => {
  const { dir, base, branch } = repoWithChange({ "docs/intro.md": "one\n" });
  assert.deepEqual(changeCounts(dir, base, branch), { files: 1, insertions: 0, deletions: 2 });
});

test("changeCounts reads an empty diff as zero of everything, which is a real answer and not null", () => {
  // `base` against itself: git prints nothing at all for no change, which
  // must read as "nothing moved", never as "could not be read".
  const { dir, base } = repoWithChange({ "docs/intro.md": "one\ntwo\nthree\nfour\n" });
  assert.deepEqual(changeCounts(dir, base, base), { files: 0, insertions: 0, deletions: 0 });
});

test("changeCounts answers null when git cannot be read, so the condition answers unknown", () => {
  assert.equal(changeCounts(mkdtempSync(join(tmpdir(), "fabrica-nogit-")), "deadbeef", "feat"), null);
  const { dir, base } = repoWithChange({ "docs/intro.md": "one\n" });
  assert.equal(changeCounts(dir, base, "no-such-branch"), null);
});

test("changeFingerprint is the patch-id's first field, and is stable for the same change", () => {
  const { dir, base, branch } = repoWithChange({ "docs/intro.md": "one\ntwo\nthree\nfour\n" });
  const first = changeFingerprint(dir, base, branch);
  assert.match(first ?? "", /^[0-9a-f]{40,64}$/);
  assert.equal(changeFingerprint(dir, base, branch), first);
});

test("a different change has a different fingerprint", () => {
  const a = repoWithChange({ "docs/intro.md": "one\ntwo\nthree\nfour\n" });
  const b = repoWithChange({ "docs/intro.md": "one\ntwo\nthree\nfive\n" });
  assert.notEqual(changeFingerprint(a.dir, a.base, a.branch), changeFingerprint(b.dir, b.base, b.branch));
});

test("the same change committed differently has the SAME fingerprint - that is what patch-id is for", () => {
  const a = repoWithChange({ "docs/intro.md": "one\ntwo\nthree\nfour\n" });
  // A second repository with the same base content and the same edit,
  // committed at a different time with a different message and so a
  // different commit id.
  const b = repoWithChange({ "docs/intro.md": "one\ntwo\nthree\nfour\n" });
  git(b.dir, "commit", "--amend", "-qm", "a completely different message");
  assert.notEqual(git(a.dir, "rev-parse", "feat").trim(), git(b.dir, "rev-parse", "feat").trim());
  assert.equal(changeFingerprint(a.dir, a.base, a.branch), changeFingerprint(b.dir, b.base, b.branch));
});

test("an empty diff and an unreadable repository both fingerprint as null", () => {
  const { dir, base } = repoWithChange({ "docs/intro.md": "one\n" });
  assert.equal(changeFingerprint(dir, base, base), null);
  assert.equal(changeFingerprint(mkdtempSync(join(tmpdir(), "fabrica-nogit-")), "deadbeef", "feat"), null);
});
