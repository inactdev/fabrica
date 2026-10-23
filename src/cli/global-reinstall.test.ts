// Installing a copy of `fabrica` from the current code on master: three
// commands, asserted as the exact argv git and npm are handed and the
// directory each runs in. Every step that would touch the machine is
// injected, so nothing here runs git or npm, makes a directory, or
// reaches the network - the point is the commands themselves, since a
// flag typed wrong is an install that silently breaks (which is what the
// one-step `npm install -g github:...` this replaced did) or one that
// cannot say which commit it is (which is what packing that same spec
// did).
//
// The chain really running, against a real local remote and a real npm,
// is installed-commit.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { commandFailureMessage, reinstallGlobalCopy, type CommandOutcome, type GlobalReinstallIo } from "./global-reinstall.ts";

const STAGING = "/tmp/fabrica-update-x1y2";
const CLONE = `${STAGING}/fabrica`;
const PREFIX = "/home/me/.npm-global";
const TARBALL = "fabrica-0.0.0.tgz";

const CLONE_ARGS = ["clone", "--depth", "1", "--branch", "master", "https://github.com/inactdev/fabrica.git", CLONE];
const PACK_ARGS = ["pack", "--pack-destination", STAGING];
const INSTALL_ARGS = ["install", "-g", "--prefix", PREFIX, `${STAGING}/${TARBALL}`];

/** One call of either command, so the order between them is asserted
 * too - a pack before its clone is as broken as a mistyped flag. */
interface Call {
  command: "git" | "npm";
  args: string[];
  cwd: string;
}

/** Records every git/npm call in order, answers each from `answers` by
 * position (success otherwise), and tracks the staging directory's
 * lifetime. `files` is what the directory holds once `pack` has run. */
function fakeIo(
  options: { answers?: CommandOutcome[]; files?: string[] } = {}
): GlobalReinstallIo & { calls: Call[]; made: number; removed: string[] } {
  const calls: Call[] = [];
  const removed: string[] = [];
  const state = { made: 0 };
  const answer = () => options.answers?.[calls.length - 1] ?? { ok: true, message: "added 1 package" };
  const io: GlobalReinstallIo = {
    git: (args, cwd) => {
      calls.push({ command: "git", args, cwd });
      return answer();
    },
    npm: (args, cwd) => {
      calls.push({ command: "npm", args, cwd });
      return answer();
    },
    makeStagingDir: () => {
      state.made += 1;
      return STAGING;
    },
    readStagingDir: () => options.files ?? [TARBALL],
    removeStagingDir: (dir) => removed.push(dir),
  };
  return {
    ...io,
    calls,
    removed,
    get made() {
      return state.made;
    },
  };
}

test("reinstallGlobalCopy: clones master, packs from inside that clone, then installs that tarball - in that order", () => {
  const io = fakeIo();

  const result = reinstallGlobalCopy(PREFIX, io);

  assert.equal(result.ok, true, result.message);
  assert.deepEqual(io.calls, [
    { command: "git", args: CLONE_ARGS, cwd: STAGING },
    // Inside the clone: that is what makes the clone the package being
    // packed, so its `.git` is what the `prepare` step reads the commit
    // from.
    { command: "npm", args: PACK_ARGS, cwd: CLONE },
    { command: "npm", args: INSTALL_ARGS, cwd: CLONE },
  ]);
  assert.equal(io.made, 1);
  // Never a GitHub spec: installing one globally symlinks the package at
  // a clone npm then deletes, and packing one packs a tree with no
  // `.git`, leaving the installed copy unable to name its commit.
  for (const { args } of io.calls) {
    assert.equal(
      args.some((arg) => arg.startsWith("github:")),
      false
    );
  }
});

test("reinstallGlobalCopy: with no prefix to name, installs into npm's own default", () => {
  const io = fakeIo();

  const result = reinstallGlobalCopy(null, io);

  assert.equal(result.ok, true, result.message);
  assert.deepEqual(io.calls.at(-1), {
    command: "npm",
    args: ["install", "-g", `${STAGING}/${TARBALL}`],
    cwd: CLONE,
  });
});

test("reinstallGlobalCopy: the staging directory is removed on the way out of a successful run", () => {
  const io = fakeIo();

  reinstallGlobalCopy(PREFIX, io);

  assert.deepEqual(io.removed, [STAGING]);
});

test("reinstallGlobalCopy: a failed clone is reported with the command that failed, and nothing is packed or installed", () => {
  const io = fakeIo({
    answers: [{ ok: false, message: "fatal: could not read from remote repository" }],
  });

  const result = reinstallGlobalCopy(PREFIX, io);

  assert.equal(result.ok, false);
  assert.equal(
    result.message,
    `git ${CLONE_ARGS.join(" ")} failed: fatal: could not read from remote repository`
  );
  assert.deepEqual(io.calls.map((call) => call.command), ["git"], "no clone, nothing to pack");
  assert.deepEqual(io.removed, [STAGING]);
});

test("reinstallGlobalCopy: a failed pack is reported with the command that failed, and nothing is installed", () => {
  const io = fakeIo({
    answers: [{ ok: true, message: "" }, { ok: false, message: "npm error code ENOENT" }],
  });

  const result = reinstallGlobalCopy(PREFIX, io);

  assert.equal(result.ok, false);
  assert.equal(result.message, `npm ${PACK_ARGS.join(" ")} failed: npm error code ENOENT`);
  assert.deepEqual(io.calls.map((call) => call.command), ["git", "npm"], "nothing to install from");
  assert.deepEqual(io.removed, [STAGING]);
});

test("reinstallGlobalCopy: a failed install is reported with the exact install command, tarball path and all", () => {
  const io = fakeIo({
    answers: [
      { ok: true, message: "" },
      { ok: true, message: TARBALL },
      { ok: false, message: "npm error EACCES: permission denied" },
    ],
  });

  const result = reinstallGlobalCopy(PREFIX, io);

  assert.equal(result.ok, false);
  assert.equal(result.message, `npm ${INSTALL_ARGS.join(" ")} failed: npm error EACCES: permission denied`);
  assert.deepEqual(io.removed, [STAGING]);
});

// npm reported success but wrote nothing we can name - a `--dry-run`
// config picked up from somewhere, a destination it could not write.
// Installing "whatever else is in there" would be worse than stopping.
test("reinstallGlobalCopy: a pack that produced no tarball installs nothing, and says so", () => {
  const io = fakeIo({ files: [] });

  const result = reinstallGlobalCopy(PREFIX, io);

  assert.equal(result.ok, false);
  assert.match(result.message, /wrote no fabrica tarball/);
  assert.match(result.message, /nothing was installed/);
  assert.deepEqual(io.calls.map((call) => call.command), ["git", "npm"]);
});

test("reinstallGlobalCopy: more than one tarball is refused rather than guessed between", () => {
  const io = fakeIo({ files: ["fabrica-0.0.0.tgz", "fabrica-0.1.0.tgz"] });

  const result = reinstallGlobalCopy(PREFIX, io);

  assert.equal(result.ok, false);
  assert.match(result.message, /wrote 2 tarballs \(fabrica-0\.0\.0\.tgz, fabrica-0\.1\.0\.tgz\)/);
  assert.deepEqual(io.calls.map((call) => call.command), ["git", "npm"]);
});

// A pack destination is read, not globbed, and the clone itself sits in
// there beside the tarball - only this package's tarball counts.
test("reinstallGlobalCopy: files in the staging dir that are not this package's tarball are ignored", () => {
  const io = fakeIo({ files: ["fabrica", ".DS_Store", "fabrica-0.0.0.tgz", "some-other-pkg-1.0.0.tgz"] });

  const result = reinstallGlobalCopy(PREFIX, io);

  assert.equal(result.ok, true, result.message);
  assert.deepEqual(io.calls.at(-1), { command: "npm", args: INSTALL_ARGS, cwd: CLONE });
});

test("commandFailureMessage: what the command said on stderr, or node's own message when it said nothing", () => {
  assert.equal(commandFailureMessage({ stderr: Buffer.from("npm error code E404\n"), message: "wrapped" }), "npm error code E404");
  assert.equal(commandFailureMessage({ message: "spawn npm ENOENT" }), "spawn npm ENOENT");
  assert.equal(commandFailureMessage("plain string"), "plain string");
});
