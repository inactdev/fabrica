// An installed copy knowing which commit it is, proven end to end: a
// real `git clone`, a real `npm pack`, a real `npm install -g` into a
// scratch prefix, and the commit read back out of what landed there
// through the same reader `fabrica doctor` uses (`detectCopy`).
//
// Both ways an installed copy can come about are run here, because only
// the pair of them says anything:
//
//   - the way `fabrica update` and README.md's install take - clone
//     first, pack from inside the clone - which must land a copy whose
//     commit is the one that was cloned;
//   - the way a hosted GitHub spec takes (`npm install -g
//     github:inactdev/fabrica`), where npm packs GitHub's tarball of the
//     tree with no `.git` in it - which must land a copy that says
//     plainly that it does not know its commit, and never a silent
//     nothing.
//
// What is installed is a two-file probe package carrying this
// repository's own `prepare` script, not fabrica itself: the script and
// the commands are what is under test, and packing 500 files to learn
// the same thing would only make this slower. The probe is named
// `fabrica` on purpose, so the production helpers that build paths and
// recognise tarballs apply to it unchanged.
//
// No network: the clone comes from a local remote, substituted into the
// production argv at the one injected seam that exists for it
// (`GlobalReinstallIo`), so everything else - the flags, the order, the
// directory each command runs in - is exactly what runs for real.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkoutCheck, detectCopy, git } from "./doctor-command.ts";
import { realGlobalReinstallIo, reinstallGlobalCopy, type GlobalReinstallIo } from "./global-reinstall.ts";
import { GLOBAL_PACKAGE_NAME, globalPackagePath, isPackedTarball, UPSTREAM_GIT_URL } from "./npm-prefix.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PREPARE_SCRIPT = join("scripts", "write-build-info.mjs");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function scratch(what: string): string {
  return mkdtempSync(join(tmpdir(), `fabrica-installed-commit-${what}-`));
}

/** The probe package's files, written into `root`. */
function writeProbePackage(root: string): void {
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      { name: GLOBAL_PACKAGE_NAME, version: "0.0.0", private: true, scripts: { prepare: `node ${PREPARE_SCRIPT}` } },
      null,
      2
    ) + "\n"
  );
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(join(REPO, PREPARE_SCRIPT), join(root, PREPARE_SCRIPT));
}

/** A git remote holding that package on master, and the commit it is
 * at - what `origin` stands in for here. */
function probeRemote(): { url: string; commit: string } {
  const root = scratch("remote");
  writeProbePackage(root);
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "probe", "--no-gpg-sign"], { cwd: root, env: GIT_ENV });
  return {
    url: `file://${root}`,
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  };
}

/** The real machine steps, with one substitution: the upstream remote
 * becomes a local one. Nothing else about the commands changes. */
function ioAgainst(remote: string): GlobalReinstallIo {
  return {
    ...realGlobalReinstallIo,
    git: (args, cwd) => realGlobalReinstallIo.git(args.map((arg) => (arg === UPSTREAM_GIT_URL ? remote : arg)), cwd),
  };
}

/** The copy that ended up under a prefix, read exactly as `fabrica
 * doctor` reads the copy it is running from. */
function installedCopy(prefix: string) {
  const root = globalPackagePath(prefix);
  return detectCopy(root, (args) => git(root, args));
}

test("installed copy: cloning first, then packing from inside the clone, lands a copy that knows its commit", () => {
  const remote = probeRemote();
  const prefix = scratch("prefix-clone");

  const result = reinstallGlobalCopy(prefix, ioAgainst(remote.url));
  assert.equal(result.ok, true, result.message);

  const copy = installedCopy(prefix);
  assert.equal(copy.kind, "installed", "npm's packing strips .git, so an installed copy is never a checkout");
  assert.equal(copy.commit, remote.commit, "the commit read back is the one that was cloned");
  assert.equal(copy.commitUnknownReason, undefined);

  // And the check the Client actually sees passes, rather than stopping
  // `fabrica up` on a copy that is in fact exactly current.
  const check = checkoutCheck(copy, remote.commit);
  assert.equal(check.ok, true, check.detail);
  assert.match(check.detail, /up to date with origin\/master/);
});

test("installed copy: the hosted-spec way, with no .git in the packed tree, says plainly that its commit is unknown", () => {
  const remote = probeRemote();
  const prefix = scratch("prefix-hosted");
  const staging = scratch("staging-hosted");

  // What npm does with `github:inactdev/fabrica`: it fetches GitHub's
  // tarball of the tree - the files, with no `.git` - and packs that.
  // Reproduced here by exporting the tree out of the same remote, so the
  // only difference from the test above is the missing `.git`.
  const tree = join(staging, "tree");
  mkdirSync(tree);
  execFileSync("git", ["clone", "--depth", "1", "--branch", "master", remote.url, tree], {
    env: GIT_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  });
  rmSync(join(tree, ".git"), { recursive: true, force: true });

  const packed = spawnSync("npm", ["pack", "--pack-destination", staging], { cwd: tree, encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  const tarball = packed.stdout.trim().split("\n").filter(isPackedTarball).at(-1);
  assert.ok(tarball, `npm pack wrote no tarball: ${packed.stdout}`);

  const installed = spawnSync("npm", ["install", "-g", "--prefix", prefix, join(staging, tarball)], {
    cwd: tree,
    encoding: "utf8",
  });
  assert.equal(installed.status, 0, installed.stderr);

  // The commit is not there to be read - but what is there says so, in
  // the words the prepare step recorded, and `commit` is an empty string
  // rather than a null nobody can tell from a missing file.
  const copy = installedCopy(prefix);
  const recorded = JSON.parse(readFileSync(join(globalPackagePath(prefix), "build-info.json"), "utf8")) as {
    commit?: string;
  };
  assert.equal(recorded.commit, "");
  assert.equal(copy.commit, null);
  assert.match(copy.commitUnknownReason ?? "", /no field npm set for the prepare step named one/);

  // And doctor turns that into a FAIL whose fix is the procedure that
  // does record a commit - never the one-step install that produced
  // this, which would send the Client round the same loop again.
  const check = checkoutCheck(copy, remote.commit);
  assert.equal(check.ok, false);
  assert.match(check.detail, /commit unknown/);
  assert.match(check.fix ?? "", /git clone --depth 1 --branch master/);
  assert.match(check.fix ?? "", /npm pack --pack-destination/);
  assert.equal((check.fix ?? "").includes("install -g github:"), false);
});
