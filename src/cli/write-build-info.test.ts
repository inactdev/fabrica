// `scripts/write-build-info.mjs` - the `prepare` step that records which
// commit a copy of fabrica was built from, the one fact `fabrica doctor`
// reads off an installed copy (`doctor-command.ts`'s `detectCopy`).
//
// Driven as the real script, in a scratch copy of its own layout
// (`<dir>/scripts/write-build-info.mjs`, since it writes
// `build-info.json` beside its own parent directory), so what is tested
// is the file npm actually runs - not a re-implementation of it. The
// scratch directory is also why nothing here can touch this checkout's
// own build-info.json.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join("scripts", "write-build-info.mjs");

/** A scratch package root with the real script in it, ready to run. */
function scratchCopy(): string {
  const root = mkdtempSync(join(tmpdir(), "fabrica-build-info-"));
  mkdirSync(join(root, "scripts"));
  copyFileSync(join(REPO, SCRIPT), join(root, SCRIPT));
  return root;
}

interface BuildInfo {
  commit?: string;
  source?: string;
  error?: string;
}

/** Runs the script exactly as `prepare` would - from the package root,
 * with the environment npm would have set - and returns what it wrote
 * plus what it said on stderr. */
function runPrepare(root: string, env: Record<string, string> = {}): { info: BuildInfo; stderr: string } {
  const run = spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    encoding: "utf8",
    // A clean environment, so this machine's own npm_* variables (`npm
    // test` is itself an npm lifecycle script, and sets several) can
    // never answer for the case under test.
    env: { PATH: process.env.PATH ?? "", ...env },
  });
  assert.equal(run.status, 0, `the prepare script failed: ${run.stderr}`);
  return { info: JSON.parse(readFileSync(join(root, "build-info.json"), "utf8")) as BuildInfo, stderr: run.stderr };
}

function gitRepoAt(root: string): string {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "x", "--no-gpg-sign"], { cwd: root, env });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

test("write-build-info: a checkout with .git records its live HEAD, and says that is where it came from", () => {
  const root = scratchCopy();
  const head = gitRepoAt(root);

  const { info } = runPrepare(root);

  assert.equal(info.commit, head);
  assert.equal(info.source, "git rev-parse HEAD");
  assert.equal(info.error, undefined);
});

// The case the clone step in `fabrica update` exists to avoid and this
// fallback exists to survive: npm fetched a hosted GitHub spec, so the
// tree being packed is GitHub's tarball of it - no `.git` anywhere - and
// the only thing naming the commit is what npm resolved the spec to.
test("write-build-info: with no .git, the commit is read out of the codeload URL npm resolved", () => {
  const root = scratchCopy();
  const commit = "b8a4afa7589aea8d1a2edeaf7ac80a6223d546c1";

  const { info } = runPrepare(root, {
    npm_package_resolved: `https://codeload.github.com/inactdev/fabrica/tar.gz/${commit}`,
  });

  assert.equal(info.commit, commit);
  assert.equal(info.source, "npm_package_resolved");
  assert.equal(info.error, undefined);
});

test("write-build-info: a git URL carrying the commit as its fragment is read the same way", () => {
  const root = scratchCopy();
  const commit = "0123456789abcdef0123456789abcdef01234567";

  const { info } = runPrepare(root, {
    npm_package_resolved: `git+https://github.com/inactdev/fabrica.git#${commit}`,
  });

  assert.equal(info.commit, commit);
  assert.equal(info.source, "npm_package_resolved");
});

// "Any other field npm sets" - the named ones are tried first, but a
// commit npm put somewhere else is still a commit, and recording it beats
// recording none.
test("write-build-info: a commit in another npm_package_* field is found too, naming that field", () => {
  const root = scratchCopy();
  const commit = "fedcba9876543210fedcba9876543210fedcba98";

  const { info } = runPrepare(root, { npm_package_gitHead: commit });

  assert.equal(info.commit, commit);
  assert.equal(info.source, "npm_package_gitHead");
});

test("write-build-info: neither source works - an empty commit and a named failure, never a silent null", () => {
  const root = scratchCopy();

  // What npm really sets for a prepare step run over an extracted
  // tarball (verified on npm 11.16.0): the directory it extracted into,
  // which names no commit at all.
  const { info, stderr } = runPrepare(root, {
    npm_package_resolved: "/home/me/.npm/_cacache/tmp/git-cloneILgEHM",
    npm_package_json: "/home/me/.npm/_cacache/tmp/git-cloneILgEHM/package.json",
    npm_package_name: "fabrica",
    npm_package_version: "0.0.0",
  });

  assert.equal(info.commit, "", "an empty commit is what doctor reports as commit unknown");
  assert.notEqual(info.commit, null);
  assert.equal(info.source, "none");
  // Named: it says which two sources came up empty, so the Client is not
  // left guessing why his copy doesn't know what it is.
  assert.match(info.error ?? "", /no \.git at /);
  assert.match(info.error ?? "", /no field npm set for the prepare step named one/);
  // Loud as well as recorded: the same sentence goes to stderr, where an
  // install run with --foreground-scripts shows it, and there it also
  // says what the consequence is - which `fabrica doctor` owns in the
  // recorded version, since it prints that one inside its own line.
  assert.match(stderr, /^fabrica: /m);
  assert.ok(stderr.includes(info.error ?? "never"));
  assert.match(stderr, /commit unknown/);
});

test("write-build-info: a value that only looks commit-shaped is not mistaken for one", () => {
  const root = scratchCopy();

  const { info } = runPrepare(root, {
    // 39 hex digits, 41 hex digits, and a hex run with a non-hex digit
    // in the middle - none of them a git object name.
    npm_package_resolved: "/tmp/abcdef0123456789abcdef0123456789abcdef0/x",
    npm_package_from: "0123456789abcdef0123456789abcdef012345678/0123456789abcdef0g23456789abcdef01234567",
  });

  assert.equal(info.commit, "");
  assert.equal(info.source, "none");
});

test("write-build-info: package.json wires this script as prepare, and .npmignore lets the file it writes ship", () => {
  const { scripts } = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(scripts.prepare, `node ${SCRIPT.split("\\").join("/")}`);

  // build-info.json is gitignored (it is generated) but must NOT be
  // npmignored, or an installed copy carries no commit however well the
  // script works. .npmignore replaces .gitignore for packing, so this is
  // the only list that decides.
  const npmignore = readFileSync(join(REPO, ".npmignore"), "utf8");
  const ignored = npmignore
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  assert.equal(ignored.includes("build-info.json"), false);
  assert.ok(readFileSync(join(REPO, ".gitignore"), "utf8").includes("build-info.json"));
});
