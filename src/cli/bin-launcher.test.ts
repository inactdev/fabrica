// Keeping a hand-written `<prefix>/bin/fabrica` launcher across the npm
// install `fabrica update` runs.
//
// These tests use the *real* filesystem seam (`realLauncherIo`) against
// a scratch prefix, and fake only the install itself - with a callback
// that does exactly what npm 11.16.0 was observed to do: write
// `<prefix>/bin/fabrica` as a relative symlink at
// `../lib/node_modules/fabrica/<bin>`. Faking the filesystem instead
// would prove nothing about the one property that matters most here,
// that the launcher's own bytes and mode come back untouched.
//
// The same thing against a real `npm install -g`, end to end, is
// installed-commit.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyBinEntry,
  checkLauncherTargets,
  installKeepingLauncher,
  launcherTargets,
  realLauncherIo,
  savedLauncherPath,
  SAVED_LAUNCHER_NAME,
  type LauncherIo,
} from "./bin-launcher.ts";
import { globalBinPath, globalPackagePath } from "./npm-prefix.ts";
import type { CommandOutcome } from "./global-reinstall.ts";

/** What npm's own global install writes, as the one fact every test
 * here leans on: the bin entry is a *relative* symlink into this
 * prefix's own copy of the package (observed on npm 11.16.0). */
const NPM_LINK_TARGET = "../lib/node_modules/fabrica/src/cli/bin.mjs";

/** A scratch prefix with this package "installed" under it: the package
 * directory, its entry script, and nothing in `bin` yet. */
function scratchPrefix(): string {
  const prefix = mkdtempSync(join(tmpdir(), "fabrica-launcher-"));
  mkdirSync(join(prefix, "bin"), { recursive: true });
  mkdirSync(join(globalPackagePath(prefix), "src", "cli"), { recursive: true });
  writeFileSync(join(globalPackagePath(prefix), "src", "cli", "bin.mjs"), "#!/usr/bin/env node\n");
  return prefix;
}

function writeNpmLink(prefix: string): void {
  symlinkSync(NPM_LINK_TARGET, globalBinPath(prefix));
}

/** The shape the Client's dotfiles write: a script that pins the node
 * Fabrica runs on and then execs this package's own entry point by
 * absolute path. */
function launcherScript(prefix: string): string {
  return [
    "#!/bin/sh",
    "# Written by dotfiles work/bootstrap.sh - pins the node Fabrica runs on.",
    'exec fnm exec --using 24.18.0 -- node "' + join(globalPackagePath(prefix), "src", "cli", "bin.mjs") + '" "$@"',
    "",
  ].join("\n");
}

function writeLauncher(prefix: string, text: string, mode = 0o755): void {
  const path = globalBinPath(prefix);
  writeFileSync(path, text);
  chmodSync(path, mode);
}

/** An install that does what npm does on success: replaces the bin
 * entry with its own relative link. */
function npmInstallSucceeding(prefix: string): () => CommandOutcome {
  return () => {
    rmSync(globalBinPath(prefix), { force: true });
    writeNpmLink(prefix);
    return { ok: true, message: "added 1 package" };
  };
}

/** An install that fails before writing anything - which is what npm's
 * own EEXIST failure did: `lib/node_modules` was left empty. */
function npmInstallFailing(): () => CommandOutcome {
  return () => ({ ok: false, message: "npm error code EACCES" });
}

test("classifyBinEntry: npm's own relative link into this prefix's copy is npm's to replace", () => {
  const prefix = scratchPrefix();
  writeNpmLink(prefix);

  assert.deepEqual(classifyBinEntry(prefix, realLauncherIo), { kind: "npm-link", target: NPM_LINK_TARGET });
});

test("classifyBinEntry: nothing there at all is absent, not a launcher", () => {
  assert.deepEqual(classifyBinEntry(scratchPrefix(), realLauncherIo), { kind: "absent" });
});

test("classifyBinEntry: a script is a launcher", () => {
  const prefix = scratchPrefix();
  writeLauncher(prefix, launcherScript(prefix));

  assert.deepEqual(classifyBinEntry(prefix, realLauncherIo), { kind: "launcher" });
});

// A launcher does not have to be a script. One that symlinks somewhere
// of its own - a wrapper in the dotfiles' own tree - is just as much
// not npm's to replace.
test("classifyBinEntry: a symlink pointing outside this prefix's copy is a launcher", () => {
  const prefix = scratchPrefix();
  const elsewhere = join(prefix, "dotfiles-wrapper");
  writeFileSync(elsewhere, "#!/bin/sh\n");
  symlinkSync(elsewhere, globalBinPath(prefix));

  assert.deepEqual(classifyBinEntry(prefix, realLauncherIo), { kind: "launcher" });
});

// The install only replaces the copy under *this* prefix, so a link into
// a different prefix's copy is not its to overwrite either.
test("classifyBinEntry: a link into another prefix's copy of the package is a launcher", () => {
  const prefix = scratchPrefix();
  const other = scratchPrefix();
  symlinkSync(join(globalPackagePath(other), "src", "cli", "bin.mjs"), globalBinPath(prefix));

  assert.deepEqual(classifyBinEntry(prefix, realLauncherIo), { kind: "launcher" });
});

// The headline requirement: a launcher survives an update byte for byte.
test("installKeepingLauncher: a launcher survives the install byte for byte, mode and all", () => {
  const prefix = scratchPrefix();
  const text = launcherScript(prefix);
  writeLauncher(prefix, text, 0o750);
  const before = lstatSync(globalBinPath(prefix));

  const result = installKeepingLauncher(prefix, realLauncherIo, npmInstallSucceeding(prefix));

  assert.equal(result.install.ok, true, result.install.message);
  assert.deepEqual(result.launcher, { kind: "kept", path: globalBinPath(prefix) });
  assert.equal(readFileSync(globalBinPath(prefix), "utf8"), text, "the launcher's own bytes, unchanged");
  const after = lstatSync(globalBinPath(prefix));
  assert.equal(after.mode, before.mode, "and its mode - a launcher that is no longer executable is no launcher");
  // A rename moves the inode, so this is the same file rather than a
  // copy of it that happened to come out the same.
  assert.equal(after.ino, before.ino);
  // Nothing left behind in a `bin` directory that is on PATH.
  assert.equal(realLauncherIo.entryAt(savedLauncherPath(prefix)), null);
});

test("installKeepingLauncher: the launcher is out of npm's way while the install runs", () => {
  const prefix = scratchPrefix();
  writeLauncher(prefix, launcherScript(prefix));
  let duringInstall: "symlink" | "file" | "other" | null = "file";

  installKeepingLauncher(prefix, realLauncherIo, () => {
    // What npm sees: nothing at the path it wants to own, which is the
    // whole point - with the launcher there it refuses the install
    // outright with EEXIST and leaves lib/node_modules empty.
    duringInstall = realLauncherIo.entryAt(globalBinPath(prefix));
    return npmInstallSucceeding(prefix)();
  });

  assert.equal(duringInstall, null);
});

test("installKeepingLauncher: a failed install still gets the launcher put back", () => {
  const prefix = scratchPrefix();
  const text = launcherScript(prefix);
  writeLauncher(prefix, text);

  const result = installKeepingLauncher(prefix, realLauncherIo, npmInstallFailing());

  assert.equal(result.install.ok, false);
  assert.deepEqual(result.launcher, { kind: "kept", path: globalBinPath(prefix) });
  assert.equal(readFileSync(globalBinPath(prefix), "utf8"), text);
});

// Nothing in global-reinstall.ts throws - it reports - but a launcher
// stranded in a hidden file because of a bug elsewhere would be a far
// worse failure than whatever was being reported.
test("installKeepingLauncher: an install that throws still gets the launcher put back, and the error through", () => {
  const prefix = scratchPrefix();
  const text = launcherScript(prefix);
  writeLauncher(prefix, text);

  assert.throws(
    () =>
      installKeepingLauncher(prefix, realLauncherIo, () => {
        throw new Error("spawn npm ENOENT");
      }),
    /spawn npm ENOENT/
  );
  assert.equal(readFileSync(globalBinPath(prefix), "utf8"), text);
  assert.equal(realLauncherIo.entryAt(savedLauncherPath(prefix)), null);
});

test("installKeepingLauncher: npm's own link is left for npm to replace, and nothing is moved", () => {
  const prefix = scratchPrefix();
  writeNpmLink(prefix);
  const moves: string[] = [];
  const io: LauncherIo = { ...realLauncherIo, move: (from, to) => moves.push(`${from} -> ${to}`) };

  const result = installKeepingLauncher(prefix, io, npmInstallSucceeding(prefix));

  assert.deepEqual(result.launcher, { kind: "none" });
  assert.deepEqual(moves, []);
  assert.equal(readlinkSync(globalBinPath(prefix)), NPM_LINK_TARGET);
});

test("installKeepingLauncher: an empty bin path is nothing to keep", () => {
  const prefix = scratchPrefix();

  const result = installKeepingLauncher(prefix, realLauncherIo, npmInstallSucceeding(prefix));

  assert.deepEqual(result.launcher, { kind: "none" });
});

// With npm's own default prefix there is no `<prefix>/bin/fabrica` this
// can name, so there is nothing to keep - said as its own outcome rather
// than reported as "there was no launcher", which would be a different
// and untrue claim.
test("installKeepingLauncher: with no prefix named, the install still runs and says the prefix is unknown", () => {
  let ran = 0;

  const result = installKeepingLauncher(null, realLauncherIo, () => {
    ran += 1;
    return { ok: true, message: "" };
  });

  assert.equal(ran, 1);
  assert.deepEqual(result.launcher, { kind: "prefix-unknown" });
});

// The Client's ruling: discard the broken launcher, keep npm's own link
// so fabrica still runs, and say which path is gone.
test("installKeepingLauncher: a launcher left pointing at nothing is discarded for npm's own link", () => {
  const prefix = scratchPrefix();
  const gone = join(globalPackagePath(prefix), "src", "cli", "moved-away.mjs");
  writeLauncher(prefix, `#!/bin/sh\nexec node "${gone}" "$@"\n`);

  const result = installKeepingLauncher(prefix, realLauncherIo, npmInstallSucceeding(prefix));

  assert.equal(result.install.ok, true);
  assert.deepEqual(result.launcher, {
    kind: "discarded",
    path: globalBinPath(prefix),
    missing: gone,
    npmLink: NPM_LINK_TARGET,
  });
  // And what is there instead is npm's own link, read back off the
  // disk - never nothing, which would leave no fabrica at all.
  assert.equal(realLauncherIo.entryAt(globalBinPath(prefix)), "symlink");
  assert.equal(readlinkSync(globalBinPath(prefix)), NPM_LINK_TARGET);
  assert.equal(realLauncherIo.exists(globalBinPath(prefix)), true, "and it resolves to a file that is really there");
});

// The link that goes back is the one npm actually wrote, read off the
// disk - not one built here out of an assumed layout.
test("installKeepingLauncher: the link put back is whatever npm itself wrote, verbatim", () => {
  const prefix = scratchPrefix();
  const gone = join(globalPackagePath(prefix), "nope.mjs");
  writeLauncher(prefix, `#!/bin/sh\nexec node "${gone}"\n`);
  const odd = "../lib/node_modules/fabrica/some/other/entry.mjs";

  const result = installKeepingLauncher(prefix, realLauncherIo, () => {
    rmSync(globalBinPath(prefix), { force: true });
    symlinkSync(odd, globalBinPath(prefix));
    return { ok: true, message: "added 1 package" };
  });

  assert.equal(result.launcher.kind, "discarded");
  assert.equal(readlinkSync(globalBinPath(prefix)), odd);
});

// The edge the ruling does not reach: with the install failed there is
// no npm link to fall back to, so removing the launcher would leave no
// fabrica at all and destroy the Client's own file on top.
test("installKeepingLauncher: a broken launcher with no npm link to fall back to is kept, and said so", () => {
  const prefix = scratchPrefix();
  const gone = join(globalPackagePath(prefix), "src", "cli", "moved-away.mjs");
  const text = `#!/bin/sh\nexec node "${gone}" "$@"\n`;
  writeLauncher(prefix, text);

  const result = installKeepingLauncher(prefix, realLauncherIo, npmInstallFailing());

  assert.deepEqual(result.launcher, { kind: "broken-kept", path: globalBinPath(prefix), missing: gone });
  assert.equal(readFileSync(globalBinPath(prefix), "utf8"), text, "the Client's own file is still his");
});

// Unknown is not missing. A launcher that works out where Fabrica lives
// at run time cannot be judged from here, so it is put back untouched
// and said to be unchecked - never passed off as fine.
test("installKeepingLauncher: a launcher naming no path inside the package is kept and reported unchecked", () => {
  const prefix = scratchPrefix();
  const text = '#!/bin/sh\nexec fnm exec --using 24.18.0 -- fabrica-real "$@"\n';
  writeLauncher(prefix, text);

  const result = installKeepingLauncher(prefix, realLauncherIo, npmInstallSucceeding(prefix));

  assert.deepEqual(result.launcher, { kind: "unverifiable", path: globalBinPath(prefix) });
  assert.equal(readFileSync(globalBinPath(prefix), "utf8"), text);
});

test("launcherTargets: a symlink names exactly one thing, wherever it points", () => {
  const prefix = scratchPrefix();
  const elsewhere = join(prefix, "wrapper");
  writeFileSync(elsewhere, "#!/bin/sh\n");
  symlinkSync("../wrapper", globalBinPath(prefix));

  assert.deepEqual(launcherTargets(prefix, realLauncherIo, globalBinPath(prefix)), [elsewhere]);
});

test("launcherTargets: a script's paths outside the package are left alone, not judged", () => {
  const prefix = scratchPrefix();
  const entry = join(globalPackagePath(prefix), "src", "cli", "bin.mjs");
  writeLauncher(
    prefix,
    [
      "#!/usr/bin/env bash",
      "# see /Users/ari/notes/fabrica.md for why",
      'export FNM_DIR=/Users/ari/.local/share/fnm',
      `exec node "${entry}" "$@" >/dev/null`,
      "",
    ].join("\n")
  );

  // Only the one path an install can invalidate. `/usr/bin/env`,
  // `/dev/null`, fnm's own directory and a path in a comment are none
  // of this command's business.
  assert.deepEqual(launcherTargets(prefix, realLauncherIo, globalBinPath(prefix)), [entry]);
});

test("launcherTargets: the same path named twice is checked once", () => {
  const prefix = scratchPrefix();
  const entry = join(globalPackagePath(prefix), "src", "cli", "bin.mjs");
  writeLauncher(prefix, `#!/bin/sh\ntest -f "${entry}" || exit 1\nexec node "${entry}" "$@"\n`);

  assert.deepEqual(launcherTargets(prefix, realLauncherIo, globalBinPath(prefix)), [entry]);
});

test("checkLauncherTargets: a path inside the package that is gone is named back", () => {
  const prefix = scratchPrefix();
  const gone = join(globalPackagePath(prefix), "src", "cli", "old-entry.mjs");
  writeLauncher(prefix, `#!/bin/sh\nexec node "${gone}"\n`);

  assert.deepEqual(checkLauncherTargets(prefix, realLauncherIo, globalBinPath(prefix)), {
    kind: "missing",
    missing: gone,
  });
});

test("checkLauncherTargets: a dangling symlink reads as missing, not as a link that is there", () => {
  const prefix = scratchPrefix();
  symlinkSync(join(globalPackagePath(prefix), "src", "cli", "gone.mjs"), globalBinPath(prefix));

  const check = checkLauncherTargets(prefix, realLauncherIo, globalBinPath(prefix));
  assert.equal(check.kind, "missing");
});

test("savedLauncherPath: the launcher waits beside itself, hidden, so the move is one rename", () => {
  const prefix = scratchPrefix();

  assert.equal(savedLauncherPath(prefix), join(prefix, "bin", SAVED_LAUNCHER_NAME));
  assert.match(SAVED_LAUNCHER_NAME, /^\./, "hidden: a bin directory is on PATH");
});
