// Keeping a hand-written `<prefix>/bin/fabrica` launcher across the npm
// install `fabrica update` runs.
//
// Why this exists. On both of the Client's Macs the dotfiles bootstrap
// writes its own launcher at `<prefix>/bin/fabrica` - a script that runs
// Fabrica on one pinned Node through fnm - and `fabrica update`
// reinstalls into that same prefix, where npm wants to own that exact
// path. Both halves of the collision were reproduced on npm 11.16.0 /
// Node 24.18.0 against a scratch prefix, rather than reasoned about:
//
//   - With the launcher in place, the install refuses: `npm error code
//     EEXIST`, "File exists: <prefix>/bin/<name>", "Remove the existing
//     file and try again, or run npm with --force to overwrite files
//     recklessly" - and `<prefix>/lib/node_modules/` was left empty
//     afterwards. Writing the bin link is not a last cosmetic step; it
//     aborts the whole install, so nothing is updated at all.
//   - With the launcher gone, npm writes its own link there instead -
//     `<prefix>/bin/<name>` -> `../lib/node_modules/<name>/bin.mjs`, a
//     relative symlink - and that link runs on whatever node the
//     terminal happens to have. That is how the work Mac ended up on
//     Node 24.16.0 inside the work repo on 2026-11-11.
//
// So, exactly what the dotfiles bootstrap's own `install_fabrica` does:
// anything at that path which is not npm's own link into this prefix's
// copy of the package is moved aside before the install and moved back
// after - after a failed install too.
//
// Three properties worth keeping in any future edit:
//
//   - Both moves are a same-directory `rename`. It is atomic and it
//     moves the inode, so the launcher comes back with identical bytes,
//     mode and ownership and there is no copy anywhere to truncate.
//     Never read-then-write.
//   - The restore is structural - the `finally` in
//     `installKeepingLauncher` - not a line each caller has to
//     remember, which is what makes "put it back if the install fails"
//     true rather than intended.
//   - npm's own link is *captured* (read with readlink before the
//     launcher goes back over the top), never reconstructed from an
//     assumed layout. It is the fallback if the restored launcher turns
//     out to point at nothing, and a fallback built out of a guess is
//     not one.
//
// Everything that touches the filesystem is one injected interface
// (`LauncherIo`), the same seam shape global-reinstall.ts uses, so a
// test can drive every outcome - and the tests that care about the bytes
// use the real one against a temp directory.

import { existsSync, lstatSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import type { CommandOutcome } from "./global-reinstall.ts";
import { GLOBAL_PACKAGE_NAME, globalBinPath, globalPackagePath } from "./npm-prefix.ts";

/** Where a launcher waits out the install: beside itself, so the move is
 * a same-filesystem rename, and hidden, so nothing completing commands
 * in a `bin` directory on PATH ever offers it. */
export const SAVED_LAUNCHER_NAME = `.${GLOBAL_PACKAGE_NAME}-launcher-saved`;

export function savedLauncherPath(prefix: string): string {
  return join(prefix, "bin", SAVED_LAUNCHER_NAME);
}

/** Every filesystem step, injectable as one object. `move` and `remove`
 * must act on the entry itself rather than follow a symlink, and `move`
 * must replace whatever is at its destination - which is how the
 * launcher goes back over the link npm just wrote. */
export interface LauncherIo {
  /** What is at `path`, not following a symlink: `null` when nothing
   * is, and `"other"` for anything that is neither a symlink nor a
   * regular file. */
  entryAt(path: string): "symlink" | "file" | "other" | null;
  /** A symlink's target exactly as recorded - relative or absolute. */
  readLink(path: string): string;
  /** A regular file's bytes as text, or `null` when they cannot be
   * read as any (a binary, or a path that is not a file at all). */
  readText(path: string): string | null;
  /** Whether a path exists, following symlinks - so a link pointing at
   * a deleted file reads as missing, which is the whole question here. */
  exists(path: string): boolean;
  /** Renames `from` onto `to`, replacing whatever is at `to`. */
  move(from: string, to: string): void;
  /** Deletes `path`; a symlink is deleted, never followed. */
  remove(path: string): void;
  /** Writes a symlink at `path` pointing at `target`, exactly as
   * recorded. */
  writeLink(path: string, target: string): void;
}

export const realLauncherIo: LauncherIo = {
  entryAt: (path) => {
    try {
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) return "symlink";
      return stats.isFile() ? "file" : "other";
    } catch {
      return null;
    }
  },
  readLink: (path) => readlinkSync(path),
  readText: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  exists: (path) => existsSync(path),
  move: (from, to) => renameSync(from, to),
  remove: (path) => rmSync(path, { force: true }),
  writeLink: (path, target) => {
    rmSync(path, { force: true });
    symlinkSync(target, path);
  },
};

/** What is sitting at `<prefix>/bin/fabrica`. Only `npm-link` is npm's
 * to replace; everything else is someone's launcher, and the install
 * would either refuse because of it or quietly replace it. */
export type BinEntry =
  | { kind: "absent" }
  /** A symlink whose target, resolved against the bin directory, lands
   * inside this prefix's own copy of the package - what npm writes.
   * `target` is the link exactly as recorded, which is what gets
   * written back if it is ever needed as a fallback. */
  | { kind: "npm-link"; target: string }
  /** A script, or a symlink pointing anywhere other than this prefix's
   * copy of the package. */
  | { kind: "launcher" };

/** Reads `<prefix>/bin/fabrica` and says which of the three it is.
 *
 * The deciding test is the resolved target, not the shape of the link
 * text: npm writes a *relative* link (`../lib/node_modules/fabrica/...`,
 * observed on npm 11.16.0), while a launcher's own symlink - if it is
 * one at all - points at some other tree entirely. A link into a
 * *different* prefix's copy of the package is a launcher by this test,
 * deliberately: this install only replaces the copy under this prefix,
 * so that link is not something it may overwrite. */
export function classifyBinEntry(prefix: string, io: LauncherIo): BinEntry {
  const path = globalBinPath(prefix);
  const entry = io.entryAt(path);
  if (entry === null) return { kind: "absent" };
  if (entry !== "symlink") return { kind: "launcher" };

  const target = io.readLink(path);
  const resolved = resolve(dirname(path), target);
  return withinPackage(prefix, resolved) ? { kind: "npm-link", target } : { kind: "launcher" };
}

/** Whether `path` is this prefix's copy of the package, or something
 * inside it. */
function withinPackage(prefix: string, path: string): boolean {
  const pkg = normalize(globalPackagePath(prefix));
  const candidate = normalize(path);
  return candidate === pkg || candidate.startsWith(pkg.endsWith(sep) ? pkg : pkg + sep);
}

/** What happened to the launcher over one install. Reported on the
 * summary line and, for the two that need acting on, on stderr. */
export type LauncherOutcome =
  /** There was no launcher to keep - npm's own link, or nothing. */
  | { kind: "none" }
  /** Moved aside, put back byte for byte, and everything it names
   * inside the package is there. */
  | { kind: "kept"; path: string }
  /** Put back byte for byte, and it names no path inside the package,
   * so whether it still starts Fabrica is not something this can
   * answer. Not a failure - unknown is not missing - but never
   * silent. */
  | { kind: "unverifiable"; path: string }
  /** Put back, found to point at `missing`, and removed in favour of
   * npm's own link so the command still starts (Client ruling). */
  | { kind: "discarded"; path: string; missing: string; npmLink: string }
  /** Points at `missing`, and the install left no link of its own to
   * fall back to - so it was kept, because nothing at all would be
   * strictly worse and would destroy the Client's own file on top. */
  | { kind: "broken-kept"; path: string; missing: string }
  /** Nothing named a prefix, so there is no `<prefix>/bin/fabrica` to
   * look at. Only reachable where the install itself is falling back to
   * npm's own default prefix. */
  | { kind: "prefix-unknown" };

/** Runs `install` with any launcher at `<prefix>/bin/fabrica` moved out
 * of npm's way, puts it back afterwards whatever the install did, and
 * then checks it still points at something.
 *
 * `install` is passed in rather than performed here so that this module
 * owns one thing only - the launcher - and the install keeps being the
 * exact npm command global-reinstall.ts spells out and its tests
 * assert. The wrapping is deliberately around *only* the install step:
 * the clone and the pack never touch `<prefix>/bin`, and the launcher
 * should be absent for as little time as possible. */
export function installKeepingLauncher(
  prefix: string | null,
  io: LauncherIo,
  install: () => CommandOutcome
): { install: CommandOutcome; launcher: LauncherOutcome } {
  if (prefix === null) return { install: install(), launcher: { kind: "prefix-unknown" } };

  const before = classifyBinEntry(prefix, io);
  if (before.kind !== "launcher") return { install: install(), launcher: { kind: "none" } };

  const path = globalBinPath(prefix);
  const saved = savedLauncherPath(prefix);
  io.move(path, saved);

  let outcome: CommandOutcome;
  try {
    outcome = install();
  } catch (err) {
    // Nothing in global-reinstall.ts throws - it reports - but a
    // launcher left in a hidden file because of a bug somewhere else
    // would be a far worse failure than the one being reported, so the
    // restore does not depend on that staying true.
    io.move(saved, path);
    throw err;
  }

  return { install: outcome, launcher: restoreLauncher(prefix, io, path, saved) };
}

/** Puts the launcher back and decides what to say about it. */
function restoreLauncher(prefix: string, io: LauncherIo, path: string, saved: string): LauncherOutcome {
  // Read before the launcher goes back over the top: this is the only
  // thing that can still start Fabrica if the launcher turns out to be
  // broken, and it exists only when the install got as far as writing
  // it.
  const installed = classifyBinEntry(prefix, io);
  const npmLink = installed.kind === "npm-link" ? installed.target : null;

  io.move(saved, path);

  const check = checkLauncherTargets(prefix, io, path);
  if (check.kind === "ok") return { kind: "kept", path };
  if (check.kind === "unverifiable") return { kind: "unverifiable", path };

  // Client ruling: discard the broken launcher, keep npm's own link so
  // fabrica still runs, exit non-zero, say which path is gone. With no
  // link to fall back to there is nothing to discard it in favour of,
  // and removing it would leave no `fabrica` at all.
  if (npmLink === null) return { kind: "broken-kept", path, missing: check.missing };
  io.writeLink(path, npmLink);
  return { kind: "discarded", path, missing: check.missing, npmLink };
}

/** Whether what is at `path` still points at files that are there.
 *
 * `unverifiable` is its own answer rather than folded into `ok`:
 * a launcher that names no path inside the package - one that works out
 * where Fabrica lives at run time, say - cannot be judged from here, and
 * calling that "fine" is the silent skip this project treats as a bug. */
export type LauncherCheck =
  | { kind: "ok"; checked: string[] }
  | { kind: "unverifiable" }
  | { kind: "missing"; missing: string };

export function checkLauncherTargets(prefix: string, io: LauncherIo, path: string): LauncherCheck {
  const checked = launcherTargets(prefix, io, path);
  if (checked === null || checked.length === 0) return { kind: "unverifiable" };
  const missing = checked.find((target) => !io.exists(target));
  return missing === undefined ? { kind: "ok", checked } : { kind: "missing", missing };
}

/** The paths the entry at `path` names and this can honestly check, or
 * `null` when it is not readable at all.
 *
 * A symlink names exactly one thing, wherever it points, so that one is
 * checked as-is. A script names whatever its text does, and only the
 * absolute paths inside this prefix's copy of the package are taken:
 * those are the ones an install can invalidate, which is the question
 * being asked, while checking every absolute token a shell script
 * happens to contain (`/dev/null`, a path in a comment, something a
 * variable would have expanded) would condemn working launchers. */
export function launcherTargets(prefix: string, io: LauncherIo, path: string): string[] | null {
  const entry = io.entryAt(path);
  if (entry === null) return null;
  if (entry === "symlink") return [resolve(dirname(path), io.readLink(path))];

  const text = io.readText(path);
  if (text === null) return null;
  return [...new Set(absolutePathsIn(text))].filter((candidate) => withinPackage(prefix, candidate));
}

/** Absolute-path-looking runs in a script's text. Stops at whitespace
 * and at the characters a shell uses to end a word, and drops trailing
 * punctuation a sentence in a comment would leave on the end. */
function absolutePathsIn(text: string): string[] {
  const matches = text.match(/\/[^\s'"`()<>|&;$*?]+/g) ?? [];
  return matches.map((match) => normalize(match.replace(/[.,:]+$/, "")));
}
