// Replacing an installed copy of `fabrica`: two npm commands, asserted
// as the exact argv npm is handed. Every step that would touch the
// machine is injected, so nothing here runs npm, makes a directory, or
// reaches the network - the point is the commands themselves, since a
// flag typed wrong is an update that silently breaks the installed
// command (which is what the one-step `npm install -g github:...` this
// replaced did).

import { test } from "node:test";
import assert from "node:assert/strict";
import { commandFailureMessage, reinstallGlobalCopy, type CommandOutcome, type GlobalReinstallIo } from "./global-reinstall.ts";

const STAGING = "/tmp/fabrica-update-x1y2";
const PREFIX = "/home/me/.npm-global";
const TARBALL = "fabrica-0.0.0.tgz";

const PACK_ARGS = ["pack", "github:inactdev/fabrica", "--pack-destination", STAGING];
const INSTALL_ARGS = ["install", "-g", "--prefix", PREFIX, `${STAGING}/${TARBALL}`];

/** Records every npm call in order, answers each from `answers` by
 * position (success otherwise), and tracks the staging directory's
 * lifetime. `files` is what the directory holds once `pack` has run. */
function fakeIo(
  options: { answers?: CommandOutcome[]; files?: string[] } = {}
): GlobalReinstallIo & { calls: string[][]; made: number; removed: string[] } {
  const calls: string[][] = [];
  const removed: string[] = [];
  const state = { made: 0 };
  const io: GlobalReinstallIo = {
    npm: (args) => {
      calls.push(args);
      return options.answers?.[calls.length - 1] ?? { ok: true, message: "added 1 package" };
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

test("reinstallGlobalCopy: packs the spec into a staging dir, then installs that tarball - in that order", () => {
  const io = fakeIo();

  const result = reinstallGlobalCopy(PREFIX, io);

  assert.equal(result.ok, true, result.message);
  assert.deepEqual(io.calls, [PACK_ARGS, INSTALL_ARGS]);
  assert.equal(io.made, 1);
  // Never the one-step form: installing a git spec globally symlinks the
  // package at a clone npm then deletes.
  for (const args of io.calls) {
    assert.equal(args.includes("github:inactdev/fabrica") && args.includes("-g"), false);
  }
});

test("reinstallGlobalCopy: with no prefix to name, installs into npm's own default", () => {
  const io = fakeIo();

  const result = reinstallGlobalCopy(null, io);

  assert.equal(result.ok, true, result.message);
  assert.deepEqual(io.calls, [PACK_ARGS, ["install", "-g", `${STAGING}/${TARBALL}`]]);
});

test("reinstallGlobalCopy: the staging directory is removed on the way out of a successful run", () => {
  const io = fakeIo();

  reinstallGlobalCopy(PREFIX, io);

  assert.deepEqual(io.removed, [STAGING]);
});

test("reinstallGlobalCopy: a failed pack is reported with the command that failed, and nothing is installed", () => {
  const io = fakeIo({
    answers: [{ ok: false, message: "npm error 404 Not Found - GET https://codeload.github.com/..." }],
  });

  const result = reinstallGlobalCopy(PREFIX, io);

  assert.equal(result.ok, false);
  assert.equal(
    result.message,
    `npm ${PACK_ARGS.join(" ")} failed: npm error 404 Not Found - GET https://codeload.github.com/...`
  );
  assert.deepEqual(io.calls, [PACK_ARGS], "nothing to install from, so nothing is installed");
  assert.deepEqual(io.removed, [STAGING]);
});

test("reinstallGlobalCopy: a failed install is reported with the exact install command, tarball path and all", () => {
  const io = fakeIo({
    answers: [
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
  assert.deepEqual(io.calls, [PACK_ARGS]);
});

test("reinstallGlobalCopy: more than one tarball is refused rather than guessed between", () => {
  const io = fakeIo({ files: ["fabrica-0.0.0.tgz", "fabrica-0.1.0.tgz"] });

  const result = reinstallGlobalCopy(PREFIX, io);

  assert.equal(result.ok, false);
  assert.match(result.message, /wrote 2 tarballs \(fabrica-0\.0\.0\.tgz, fabrica-0\.1\.0\.tgz\)/);
  assert.deepEqual(io.calls, [PACK_ARGS]);
});

// A pack destination is read, not globbed, and npm writes its own
// notices in there too on some configurations - only this package's
// tarball counts.
test("reinstallGlobalCopy: files in the staging dir that are not this package's tarball are ignored", () => {
  const io = fakeIo({ files: [".DS_Store", "fabrica-0.0.0.tgz", "some-other-pkg-1.0.0.tgz"] });

  const result = reinstallGlobalCopy(PREFIX, io);

  assert.equal(result.ok, true, result.message);
  assert.deepEqual(io.calls, [PACK_ARGS, INSTALL_ARGS]);
});

test("commandFailureMessage: what the command said on stderr, or node's own message when it said nothing", () => {
  assert.equal(commandFailureMessage({ stderr: Buffer.from("npm error code E404\n"), message: "wrapped" }), "npm error code E404");
  assert.equal(commandFailureMessage({ message: "spawn npm ENOENT" }), "spawn npm ENOENT");
  assert.equal(commandFailureMessage("plain string"), "plain string");
});
