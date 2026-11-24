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
import type { LauncherIo } from "./bin-launcher.ts";
import { globalBinPath, globalPackagePath } from "./npm-prefix.ts";

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

/** A filesystem that is just a map of path -> what is there, enough to
 * drive the launcher's move-aside and put-back without touching a real
 * disk. `null` entries are absent; `files` carries the bytes of a
 * regular file, `links` a symlink's recorded target. The real seam
 * against a real directory is bin-launcher.test.ts's business.
 *
 * `installWritesNpmLink` is what npm does on a successful install -
 * writing its own relative link at `<prefix>/bin/fabrica` - played back
 * when the install command runs. */
function fakeLauncherIo(initial: { files?: Record<string, string>; links?: Record<string, string> } = {}) {
  const files = new Map(Object.entries(initial.files ?? {}));
  const links = new Map(Object.entries(initial.links ?? {}));
  const moves: string[] = [];
  const io: LauncherIo = {
    entryAt: (path) => (links.has(path) ? "symlink" : files.has(path) ? "file" : null),
    readLink: (path) => links.get(path) as string,
    readText: (path) => files.get(path) ?? null,
    exists: (path) => files.has(path) || links.has(path),
    move: (from, to) => {
      moves.push(`${from} -> ${to}`);
      if (!files.has(from) && !links.has(from)) throw new Error(`nothing at ${from} to move`);
      // A rename replaces whatever is at the destination - which is how
      // the launcher goes back over the link npm just wrote.
      files.delete(to);
      links.delete(to);
      if (links.has(from)) {
        links.set(to, links.get(from) as string);
        links.delete(from);
      } else {
        files.set(to, files.get(from) as string);
        files.delete(from);
      }
    },
    remove: (path) => {
      files.delete(path);
      links.delete(path);
    },
    writeLink: (path, target) => {
      files.delete(path);
      links.set(path, target);
    },
  };
  return { io, files, links, moves };
}

/** Records every git/npm call in order, answers each from `answers` by
 * position (success otherwise), and tracks the staging directory's
 * lifetime. `files` is what the directory holds once `pack` has run. */
function fakeIo(
  options: { answers?: CommandOutcome[]; files?: string[]; launcher?: LauncherIo } = {}
): GlobalReinstallIo & { calls: Call[]; made: number; removed: string[] } {
  const calls: Call[] = [];
  const removed: string[] = [];
  const state = { made: 0 };
  const answer = () => options.answers?.[calls.length - 1] ?? { ok: true, message: "added 1 package" };
  const io: GlobalReinstallIo = {
    launcher: options.launcher ?? fakeLauncherIo().io,
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

// The launcher's move-aside wraps the install step and nothing else -
// the clone and the pack never go near `<prefix>/bin`, and the launcher
// should be absent for as little time as possible. What it is wrapped
// around being the install, rather than the whole run, is what this
// asserts: the move happens after the pack, and the put-back before the
// function returns.
test("reinstallGlobalCopy: a launcher is moved aside around the install step alone, and put back", () => {
  const bin = globalBinPath(PREFIX);
  const saved = `${PREFIX}/bin/.fabrica-launcher-saved`;
  const script = `#!/bin/sh\nexec node "${globalPackagePath(PREFIX)}/src/cli/bin.mjs" "$@"\n`;
  const launcher = fakeLauncherIo({
    files: { [bin]: script, [`${globalPackagePath(PREFIX)}/src/cli/bin.mjs`]: "entry" },
  });
  const io = fakeIo({ launcher: launcher.io });

  const result = reinstallGlobalCopy(PREFIX, io);

  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.launcher, { kind: "kept", path: bin });
  assert.deepEqual(launcher.moves, [`${bin} -> ${saved}`, `${saved} -> ${bin}`]);
  assert.equal(launcher.files.get(bin), script, "the same bytes, back where they were");
  assert.equal(launcher.files.has(saved), false);
});

test("reinstallGlobalCopy: npm's own link is left alone - there is no launcher to keep", () => {
  const io = fakeIo({
    launcher: fakeLauncherIo({ links: { [globalBinPath(PREFIX)]: "../lib/node_modules/fabrica/src/cli/bin.mjs" } }).io,
  });

  const result = reinstallGlobalCopy(PREFIX, io);

  assert.deepEqual(result.launcher, { kind: "none" });
});

// A failure before the install never touched `<prefix>/bin`, so there is
// nothing to report about the launcher - and nothing was moved.
test("reinstallGlobalCopy: a clone or pack that failed reports no launcher move at all", () => {
  const bin = globalBinPath(PREFIX);
  for (const answers of [
    [{ ok: false, message: "fatal: could not read from remote repository" }],
    [{ ok: true, message: "" }, { ok: false, message: "npm error code ENOENT" }],
  ]) {
    const launcher = fakeLauncherIo({ files: { [bin]: "#!/bin/sh\n" } });
    const result = reinstallGlobalCopy(PREFIX, fakeIo({ answers, launcher: launcher.io }));

    assert.equal(result.ok, false);
    assert.deepEqual(result.launcher, { kind: "none" });
    assert.deepEqual(launcher.moves, []);
  }
});

// `fabrica update` reads this field to decide its own exit code, so a
// launcher the install broke has to survive the trip out of here even
// when the install itself succeeded.
test("reinstallGlobalCopy: a launcher left pointing at nothing is reported on a successful install", () => {
  const bin = globalBinPath(PREFIX);
  const gone = `${globalPackagePath(PREFIX)}/src/cli/old-entry.mjs`;
  const launcher = fakeLauncherIo({ files: { [bin]: `#!/bin/sh\nexec node "${gone}"\n` } });
  const io = fakeIo({ launcher: launcher.io });
  // What npm does on success, replayed when the install command runs.
  const npm = io.npm;
  io.npm = (args, cwd) => {
    const outcome = npm(args, cwd);
    if (args[0] === "install") launcher.io.writeLink(bin, "../lib/node_modules/fabrica/src/cli/bin.mjs");
    return outcome;
  };

  const result = reinstallGlobalCopy(PREFIX, io);

  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.launcher, {
    kind: "discarded",
    path: bin,
    missing: gone,
    npmLink: "../lib/node_modules/fabrica/src/cli/bin.mjs",
  });
  assert.equal(launcher.links.get(bin), "../lib/node_modules/fabrica/src/cli/bin.mjs");
});

test("reinstallGlobalCopy: with no prefix to name, there is no bin path to look at", () => {
  assert.deepEqual(reinstallGlobalCopy(null, fakeIo()).launcher, { kind: "prefix-unknown" });
});

test("commandFailureMessage: what the command said on stderr, or node's own message when it said nothing", () => {
  assert.equal(commandFailureMessage({ stderr: Buffer.from("npm error code E404\n"), message: "wrapped" }), "npm error code E404");
  assert.equal(commandFailureMessage({ message: "spawn npm ENOENT" }), "spawn npm ENOENT");
  assert.equal(commandFailureMessage("plain string"), "plain string");
});
