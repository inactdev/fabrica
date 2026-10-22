// Real git, every time: this module exists to answer a question about a
// genuine repository's refs, and a fake would only prove that the fake
// agrees with itself. Each test builds an upstream repo, clones it into a
// "project", and moves one or the other - which is exactly the shape a
// delivered task's branch is in when origin has moved on under it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseStandingOf, describeBaseStanding, describeBaseStandingOf } from "./base-standing.ts";

/** A throwaway identity and no hooks - a test machine may have neither
 * configured, and this suite commits. */
function git(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Fabrica Test", "-c", "user.email=test@example.com", "-c", "core.hooksPath=/dev/null", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();
}

const homes: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-base-standing-"));
  homes.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of homes) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  root: string;
  upstream: string;
  project: string;
  /** origin's default branch - deliberately not "master" in most tests
   * below, since "never assumed" is one of the things being proven. */
  base: string;
  branch: string;
}

/** An upstream repo with one commit, cloned into `project`, with a task
 * branch cut from origin's tip - a ProductionLine's branch the moment
 * after it was created. */
function makeFixture(base = "trunk", branch = "fabrica/task-1"): Fixture {
  const root = tempRoot();
  const upstream = join(root, "upstream");
  mkdirSync(upstream);
  git(upstream, ["init", "-q", "-b", base, "."]);
  writeFileSync(join(upstream, "README.md"), "one\n");
  git(upstream, ["add", "-A"]);
  git(upstream, ["commit", "-q", "-m", "one"]);

  const project = join(root, "project");
  git(root, ["clone", "-q", upstream, project]);
  git(project, ["branch", branch]);
  return { root, upstream, project, base, branch };
}

/** Moves origin forward and fetches it, so the project's own
 * remote-tracking ref is ahead of the task branch - the only state this
 * module ever reads, since it never fetches itself. */
function advanceOrigin(fixture: Fixture): void {
  writeFileSync(join(fixture.upstream, "README.md"), "two\n");
  git(fixture.upstream, ["add", "-A"]);
  git(fixture.upstream, ["commit", "-q", "-m", "two"]);
  git(fixture.project, ["fetch", "-q", "origin"]);
}

test("a branch that still contains origin's default tip is current, and marked with nothing", () => {
  const fixture = makeFixture();
  const standing = baseStandingOf(fixture.project, fixture.branch);
  assert.equal(standing.status, "current");
  assert.equal(describeBaseStanding(standing), null, "a current branch gets no mark at all");
});

test("a branch behind origin's default tip reads as behind, naming the real branch", () => {
  const fixture = makeFixture();
  advanceOrigin(fixture);

  const standing = baseStandingOf(fixture.project, fixture.branch);
  assert.equal(standing.status, "behind");
  assert.equal(standing.status === "behind" ? standing.base : null, "trunk", "origin's default branch is read, never assumed");

  const label = describeBaseStanding(standing);
  assert.ok(label, "a behind branch is marked");
  assert.match(label!, /^behind origin\/trunk, a fix will rebase/);
  // The freshness caveat on a local-refs-only reading: the fetch that
  // produced this ref just happened, so it reads in seconds.
  assert.match(label!, /\(origin last fetched \d+s ago\)$/);
});

test("the branch's own commits on top of origin's tip still count as current", () => {
  const fixture = makeFixture();
  // A worker's own work on the task branch, with origin left alone: the
  // branch is ahead, not behind, and a fix has nothing to rebase.
  const worktree = join(fixture.root, "work");
  git(fixture.project, ["worktree", "add", "-q", worktree, fixture.branch]);
  writeFileSync(join(worktree, "work.txt"), "the worker's change\n");
  git(worktree, ["add", "-A"]);
  git(worktree, ["commit", "-q", "-m", "work"]);

  assert.equal(baseStandingOf(fixture.project, fixture.branch).status, "current");
});

test("a branch behind origin AND carrying its own commits still reads as behind", () => {
  const fixture = makeFixture();
  const worktree = join(fixture.root, "work");
  git(fixture.project, ["worktree", "add", "-q", worktree, fixture.branch]);
  writeFileSync(join(worktree, "work.txt"), "the worker's change\n");
  git(worktree, ["add", "-A"]);
  git(worktree, ["commit", "-q", "-m", "work"]);
  advanceOrigin(fixture);

  assert.equal(baseStandingOf(fixture.project, fixture.branch).status, "behind");
});

test("origin's default branch comes from origin/HEAD's symref, not from the branch named master", () => {
  // Two branches on origin, "master" among them, with origin/HEAD
  // pointing at the other one: a reading that assumed "master" would
  // compare against the wrong branch entirely and get the opposite
  // answer from the right one.
  const fixture = makeFixture("main");
  git(fixture.upstream, ["branch", "master"]);
  advanceOrigin(fixture); // moves "main" only
  git(fixture.project, ["fetch", "-q", "origin"]);

  const standing = baseStandingOf(fixture.project, fixture.branch);
  assert.equal(standing.status, "behind");
  assert.equal(standing.status === "behind" ? standing.base : null, "main");
  assert.match(describeBaseStanding(standing)!, /behind origin\/main/);
});

test("no origin/HEAD in the checkout is `base unknown`, pointing at the command that sets it", () => {
  const fixture = makeFixture();
  git(fixture.project, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);

  const standing = baseStandingOf(fixture.project, fixture.branch);
  assert.equal(standing.status, "unknown");
  const label = describeBaseStanding(standing)!;
  assert.match(label, /^base unknown: origin\/HEAD is not set in /);
  assert.match(label, /git remote set-head origin -a/);
});

test("a project with no origin remote is `base unknown`, saying there is no default branch to be behind", () => {
  const fixture = makeFixture();
  // `git remote remove` takes the remote-tracking refs, origin/HEAD
  // included, with it - there is nothing left to compare against.
  git(fixture.project, ["remote", "remove", "origin"]);

  const label = describeBaseStandingOf(fixture.project, fixture.branch)!;
  assert.match(label, /^base unknown: /);
  assert.match(label, /has no "origin" remote/);
});

test("a branch that is gone from the project is `base unknown`, naming it", () => {
  const fixture = makeFixture();
  git(fixture.project, ["branch", "-D", fixture.branch]);

  const label = describeBaseStandingOf(fixture.project, fixture.branch)!;
  assert.equal(label, `base unknown: the branch ${fixture.branch} is gone from ${fixture.project}`);
});

test("a project folder that is no longer there is `base unknown`, saying so in plain words", () => {
  const fixture = makeFixture();
  rmSync(fixture.project, { recursive: true, force: true });

  const label = describeBaseStandingOf(fixture.project, fixture.branch)!;
  assert.equal(label, `base unknown: the project folder ${fixture.project} is not there any more`);
});

test("a folder that is not a git repository is `base unknown`, in git's own words", () => {
  const dir = tempRoot();
  const label = describeBaseStandingOf(dir, "fabrica/task-1")!;
  assert.match(label, /^base unknown: /);
  assert.match(label, /not a git repository/i);
  assert.equal(label.split("\n").length, 1, "a reason is one line - it goes on a status listing");
});

test("no project or no branch on the record is `base unknown`, never a silent pass", () => {
  assert.equal(describeBaseStandingOf(null, "fabrica/task-1"), "base unknown: no project recorded for this task");
  assert.equal(describeBaseStandingOf("   ", "fabrica/task-1"), "base unknown: no project recorded for this task");
  const fixture = makeFixture();
  assert.equal(describeBaseStandingOf(fixture.project, null), "base unknown: no branch recorded on the delivery");
  assert.equal(describeBaseStandingOf(fixture.project, ""), "base unknown: no branch recorded on the delivery");
});

test("a checkout that has never fetched is still read, just without the freshness clause", () => {
  // `git clone` writes no FETCH_HEAD (verified on git 2.54.0), so a
  // freshly cloned project has no local record of a fetch at all. The
  // standing is still knowable; only the "how old is this" caveat isn't.
  const fixture = makeFixture();
  const standing = baseStandingOf(fixture.project, fixture.branch);
  assert.equal(standing.status, "current");
  assert.equal(standing.status === "current" ? standing.fetchedAgoMs : 0, null);

  // And the same on the branch that matters: behind, with no clause.
  // Fetched, then the file git wrote for it taken away again - the
  // "something else brought origin's tip in" case, where the standing is
  // knowable but its age is not.
  advanceOrigin(fixture);
  rmSync(join(fixture.project, ".git", "FETCH_HEAD"));
  assert.equal(describeBaseStandingOf(fixture.project, fixture.branch), "behind origin/trunk, a fix will rebase");
});

test("the fetch age in the label is the real age of the last fetch", () => {
  const fixture = makeFixture();
  advanceOrigin(fixture);
  const now = Date.now() + 90 * 60 * 1000; // an hour and a half later
  assert.match(describeBaseStandingOf(fixture.project, fixture.branch, now)!, /\(origin last fetched 1h30m ago\)$/);
});

/** Every file under `dir`, with its size, mtime and a hash of its
 * contents - `.git` very much included, since that is where a careless
 * read would write (a fetched ref, a rewritten FETCH_HEAD, a refreshed
 * index). */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const stat = statSync(path);
      const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
      out[path.slice(dir.length)] = `${stat.size} ${stat.mtimeMs} ${hash}`;
    }
  };
  walk(dir);
  return out;
}

test("the check writes nothing - not one byte of the project, .git included", () => {
  const fixture = makeFixture();
  advanceOrigin(fixture);
  // A branch sitting exactly on origin's new tip, so the "current" path
  // is exercised too - created before the snapshot, since creating it
  // is itself a write.
  git(fixture.project, ["branch", "at-the-tip", `refs/remotes/origin/${fixture.base}`]);

  const before = snapshot(fixture.project);
  // Every path through the module, including the ones that fall back to
  // a second git call to explain themselves.
  assert.equal(baseStandingOf(fixture.project, fixture.branch).status, "behind");
  assert.equal(baseStandingOf(fixture.project, "fabrica/no-such-task").status, "unknown");
  assert.equal(baseStandingOf(fixture.project, "at-the-tip").status, "current");
  const after = snapshot(fixture.project);

  assert.deepEqual(after, before, "a reporting check must leave the Client's repository exactly as it found it");
});

test("the check never fetches - origin moving is invisible until something else fetches", () => {
  const fixture = makeFixture();
  // origin really has moved; nothing has fetched it into this checkout.
  writeFileSync(join(fixture.upstream, "README.md"), "two\n");
  git(fixture.upstream, ["add", "-A"]);
  git(fixture.upstream, ["commit", "-q", "-m", "two"]);

  assert.equal(
    baseStandingOf(fixture.project, fixture.branch).status,
    "current",
    "local refs only: the mark is as fresh as the last fetch, and says so"
  );
  git(fixture.project, ["fetch", "-q", "origin"]);
  assert.equal(baseStandingOf(fixture.project, fixture.branch).status, "behind");
});
