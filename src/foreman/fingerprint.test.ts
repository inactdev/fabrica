// Real git, every time - the same reason `base-standing.test.ts` uses
// it: this module answers a question about a genuine repository's
// history, and the one property that matters (the id survives a rebase)
// cannot be demonstrated by a fake agreeing with itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changeFingerprintOf,
  compareFingerprint,
  describeFingerprint,
  NOT_COMMITTED,
  shortPatchId,
  stampFor,
  unstamped,
  UNSTAMPED_OLD_RECORD,
} from "./fingerprint.ts";
import type { PassFingerprint } from "./fingerprint.ts";

/** A throwaway identity and no hooks - a test machine may have neither
 * configured, and this suite commits. */
function git(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Fabrica Test", "-c", "user.email=test@example.com", "-c", "core.hooksPath=/dev/null", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();
}

const roots: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-fingerprint-"));
  roots.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  root: string;
  upstream: string;
  project: string;
  /** Deliberately not "master": "never assumed" is one of the things
   * being proven here, exactly as in `base-standing.test.ts`. */
  base: string;
  branch: string;
  /** The linked worktree a ProductionLine would hand a worker. */
  workdir: string;
}

/** An upstream repo with one commit, cloned into `project`, with a task
 * branch checked out in its own linked worktree - a ProductionLine the
 * moment after it was created. */
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
  const workdir = join(root, "workdir");
  git(project, ["worktree", "add", "-q", "--no-track", "-b", branch, workdir, `refs/remotes/origin/${base}`]);
  return { root, upstream, project, base, branch, workdir };
}

/** One commit in the task's worktree - what a worker's attempt leaves
 * behind once `attempts.ts` has committed it. */
function work(fixture: Fixture, file: string, content: string, message: string): void {
  writeFileSync(join(fixture.workdir, file), content);
  git(fixture.workdir, ["add", "-A"]);
  git(fixture.workdir, ["commit", "-q", "-m", message]);
}

/** Moves origin forward and fetches it into the project, the way the fix
 * round's own rebase does before it replays anything. */
function advanceOrigin(fixture: Fixture): void {
  writeFileSync(join(fixture.upstream, "unrelated.md"), "upstream moved\n");
  git(fixture.upstream, ["add", "-A"]);
  git(fixture.upstream, ["commit", "-q", "-m", "upstream"]);
  git(fixture.project, ["fetch", "-q", "origin"]);
}

test("a branch with work on it gets a patch id, and names the base it was taken against", () => {
  const fixture = makeFixture();
  work(fixture, "feature.txt", "the change\n", "attempt 1");

  const stamp = changeFingerprintOf(fixture.workdir);
  assert.ok(stamp.patchId, "a committed change must be stamped");
  assert.match(stamp.patchId!, /^[0-9a-f]{40}$/, "a patch id is a plain object name");
  assert.equal(stamp.baseBranch, fixture.base, "origin's default branch is read, never assumed");
  assert.equal(
    stamp.base,
    git(fixture.project, ["rev-parse", `refs/remotes/origin/${fixture.base}`]),
    "the base is the merge-base with origin's default branch"
  );
  assert.equal(stamp.reason, undefined, "a stamped fingerprint carries no reason");
});

test("the patch id survives a rebase onto a moved origin - the whole point", () => {
  const fixture = makeFixture();
  work(fixture, "feature.txt", "the change\n", "attempt 1");
  const before = changeFingerprintOf(fixture.workdir);

  advanceOrigin(fixture);
  const movedTip = git(fixture.project, ["rev-parse", `refs/remotes/origin/${fixture.base}`]);
  git(fixture.workdir, ["rebase", "-q", `refs/remotes/origin/${fixture.base}`]);

  const after = changeFingerprintOf(fixture.workdir);
  assert.notEqual(
    git(fixture.workdir, ["rev-parse", "HEAD"]),
    before.base,
    "the rebase really did rewrite the branch"
  );
  assert.equal(after.patchId, before.patchId, "the same change hashes the same after a rebase");
  assert.equal(after.base, movedTip, "and the base it is taken against has moved with origin");
  assert.notEqual(after.base, before.base);
});

test("the patch id changes when the change does", () => {
  const fixture = makeFixture();
  work(fixture, "feature.txt", "the change\n", "attempt 1");
  const first = changeFingerprintOf(fixture.workdir);

  work(fixture, "feature.txt", "a different change\n", "attempt 2");
  const second = changeFingerprintOf(fixture.workdir);

  assert.ok(second.patchId);
  assert.notEqual(second.patchId, first.patchId);
});

test("a second commit that reverts the first leaves the branch unstamped, not stamped as nothing", () => {
  const fixture = makeFixture();
  work(fixture, "feature.txt", "the change\n", "attempt 1");
  git(fixture.workdir, ["revert", "--no-edit", "HEAD"]);

  const stamp = changeFingerprintOf(fixture.workdir);
  assert.equal(stamp.patchId, null, "git patch-id prints nothing for an empty diff, so there is no id to record");
  assert.match(stamp.reason ?? "", /holds no change against origin\/trunk/);
  assert.equal(stamp.base, git(fixture.project, ["rev-parse", `refs/remotes/origin/${fixture.base}`]));
});

test("a branch with no work on it yet is unstamped, with a reason, and never throws", () => {
  const fixture = makeFixture();
  const stamp = changeFingerprintOf(fixture.workdir);
  assert.equal(stamp.patchId, null);
  assert.match(stamp.reason ?? "", /holds no change/);
});

test("no origin/HEAD means unstamped with a reason, never a guess at \"master\"", () => {
  const root = tempRoot();
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main", "."]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "one"]);

  const stamp = changeFingerprintOf(repo);
  assert.equal(stamp.patchId, null);
  assert.equal(stamp.baseBranch, null);
  assert.match(stamp.reason ?? "", /origin\/HEAD is not set/);
});

test("a working folder that is not there is unstamped, naming that and not git's plumbing", () => {
  const stamp = changeFingerprintOf(join(tempRoot(), "never-created"));
  assert.equal(stamp.patchId, null);
  assert.match(stamp.reason ?? "", /is not there/);
  assert.doesNotMatch(stamp.reason ?? "", /ENOENT/);
});

test("nothing here reaches the network: the stamp is taken with no fetch at all", () => {
  const fixture = makeFixture();
  work(fixture, "feature.txt", "the change\n", "attempt 1");
  // Point origin at a path that does not exist. Any fetch would fail
  // loudly; a local-refs-only read cannot notice.
  git(fixture.project, ["remote", "set-url", "origin", join(fixture.root, "gone")]);

  const stamp = changeFingerprintOf(fixture.workdir);
  assert.ok(stamp.patchId, "the stamp is taken from refs already on disk");
});

test("a pass that repeats the previous pass's change reads as unchanged", () => {
  const prior: PassFingerprint[] = [{ pass: 1, patchId: "a".repeat(40) }];
  const match = compareFingerprint(prior, { patchId: "a".repeat(40), base: "b", baseBranch: "main" });
  assert.deepEqual(match, {
    matched: true,
    previous: "a".repeat(40),
    previousPass: 1,
    matchedPass: 1,
    voidsEarlierObservations: false,
  });
});

test("a pass with a change nothing was ever observed at voids every earlier observation", () => {
  const prior: PassFingerprint[] = [
    { pass: 1, patchId: "a".repeat(40) },
    { pass: 2, patchId: "b".repeat(40) },
  ];
  const match = compareFingerprint(prior, { patchId: "c".repeat(40), base: "x", baseBranch: "main" });
  assert.equal(match?.matched, false);
  assert.equal(match?.voidsEarlierObservations, true);
  assert.equal(match?.previousPass, 2, "compared against the pass immediately before it");
  assert.equal(match?.previous, "b".repeat(40));
  assert.equal(match?.matchedPass, undefined);
});

test("a pass that comes back to an earlier change reads as matched, and the record says which pass", () => {
  const prior: PassFingerprint[] = [
    { pass: 1, patchId: "a".repeat(40) },
    { pass: 2, patchId: "b".repeat(40) },
  ];
  const match = compareFingerprint(prior, { patchId: "a".repeat(40), base: "x", baseBranch: "main" });
  assert.equal(match?.matched, true);
  assert.equal(match?.matchedPass, 1, "matched the earlier pass it returned to");
  assert.equal(match?.previousPass, 2, "and still says what the pass before it carried");
  assert.equal(match?.voidsEarlierObservations, false);
});

test("nothing is compared when there is no earlier pass, or no stamp to compare", () => {
  assert.equal(compareFingerprint([], { patchId: "a".repeat(40), base: "x", baseBranch: "main" }), null);
  assert.equal(compareFingerprint([{ pass: 1, patchId: "a".repeat(40) }], unstamped(NOT_COMMITTED)), null);
});

test("every surface's wording comes from one function, and always says something", () => {
  const id = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(describeFingerprint({ patchId: id, base: "x", baseBranch: "main" }), `fingerprint ${shortPatchId(id)}`);
  assert.equal(shortPatchId(id), "0123456");

  assert.equal(
    describeFingerprint(undefined),
    `fingerprint unstamped: ${UNSTAMPED_OLD_RECORD}`,
    "a record written before fingerprints existed reads as unstamped, never as a stamp that failed"
  );
  assert.equal(describeFingerprint(unstamped(NOT_COMMITTED)), `fingerprint unstamped: ${NOT_COMMITTED}`);

  const unchanged = describeFingerprint({ patchId: id, base: "x", baseBranch: "main" }, {
    matched: true,
    previous: id,
    previousPass: 2,
    matchedPass: 2,
    voidsEarlierObservations: false,
  });
  assert.match(unchanged, /unchanged since pass 2/);

  const changed = describeFingerprint({ patchId: id, base: "x", baseBranch: "main" }, {
    matched: false,
    previous: "f".repeat(40),
    previousPass: 1,
    voidsEarlierObservations: true,
  });
  assert.match(changed, /changed from pass 1 \(fffffff\)/);
  assert.match(changed, /every earlier Inspector stamp, check result and CI conclusion on this task is void/);

  const returned = describeFingerprint({ patchId: id, base: "x", baseBranch: "main" }, {
    matched: true,
    previous: "f".repeat(40),
    previousPass: 3,
    matchedPass: 1,
    voidsEarlierObservations: false,
  });
  assert.match(returned, /back to the change pass 1 carried \(pass 3 had fffffff\)/);
});

test("stampFor reads the branch and compares in one step", () => {
  const fixture = makeFixture();
  work(fixture, "feature.txt", "the change\n", "attempt 1");
  const first = stampFor(fixture.workdir, []);
  assert.ok(first.fingerprint.patchId);
  assert.equal(first.fingerprintMatch, undefined, "a first pass has nothing to compare against");

  const second = stampFor(fixture.workdir, [{ pass: 1, patchId: first.fingerprint.patchId! }]);
  assert.equal(second.fingerprintMatch?.matched, true);
  assert.equal(second.fingerprintMatch?.voidsEarlierObservations, false);
});
