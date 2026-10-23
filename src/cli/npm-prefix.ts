// npm's global install layout, as the three facts the `fabrica` command
// needs from it: which prefix a given copy of this package is installed
// under, which prefix the executable on `PATH` came from, and - the
// reverse - where any prefix keeps its copy of this package. Plus the
// commands those prefixes are for, each spelled exactly once - the three
// steps that install a copy which knows its own commit
// (`cloneCommandArgs`, `packInCloneCommandArgs`,
// `installTarballCommandArgs`, and `clonePackInstallProcedure` for
// printing them to a person) - since a command that is printed in one
// place and run in another must be the same command.
//
// Taken from npm's own current documentation (`configuring-npm/folders`:
// "Global installs on Unix systems go to `{prefix}/lib/node_modules`"
// and "When in global mode, executables are linked into `{prefix}/bin`
// on Unix") and verified against real installs - `npm install -g
// --prefix <dir>` lands the package at `<dir>/lib/node_modules/<name>`
// with its executable symlinked into `<dir>/bin`, and a copy running
// through that executable sees exactly that package directory as its
// own root. Only the Unix layout is derived here: Windows drops the
// `lib` level, and this module's siblings already assume a POSIX
// machine (`ps`, `setsid`, Docker).
//
// Why anything needs this at all: npm's *default* global prefix is the
// folder node itself is installed in, which on a Nix-managed host is a
// read-only store path - so `npm install -g` with npm's own default
// cannot reinstall a copy of fabrica that was installed under some
// other, writable prefix. The running copy's own path is the only
// evidence of which prefix that was, which is why `fabrica update`
// derives it from there (`prefixOfGlobalInstall`) rather than asking
// npm where it would put things.

import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";

/** The name npm installs and links this package under - `package.json`'s
 * own `name`, which `npm-prefix.test.ts` holds it to, since every path
 * built here is wrong the moment the two disagree. */
export const GLOBAL_PACKAGE_NAME = "fabrica";

/** An absolute path with no trailing separator or `.`/`..` segments, or
 * `null` for anything that isn't an absolute path at all (empty, or
 * relative - neither of which can name a prefix). */
export function normalizedPrefix(path: string | undefined | null): string | null {
  if (path === undefined || path === null || path.trim() === "") return null;
  const normalized = normalize(path.trim());
  if (!isAbsolute(normalized)) return null;
  return normalized.length > 1 && normalized.endsWith(sep) ? normalized.slice(0, -1) : normalized;
}

/** `<prefix>/lib/node_modules/<name>` -> `<prefix>`, and `null` for any
 * path that is not a global install: an npx cache's
 * `.../_npx/<hash>/node_modules/<name>`, a project's own
 * `node_modules/<name>`, or a plain checkout. `null` means "nothing
 * here says which prefix this is" - never a guess. */
export function prefixOfGlobalInstall(root: string | undefined | null): string | null {
  const path = normalizedPrefix(root);
  if (path === null) return null;
  const nodeModules = dirname(path);
  const lib = dirname(nodeModules);
  if (basename(nodeModules) !== "node_modules" || basename(lib) !== "lib") return null;
  const prefix = dirname(lib);
  return prefix === lib ? null : prefix;
}

/** `<prefix>/bin/<exe>` -> `<prefix>`, and `null` for anything else.
 * Node resolves a script's own module path through symlinks but leaves
 * `process.argv[1]` as typed, so for both an installed copy and an
 * `npm link`ed checkout that argument is the `<prefix>/bin/fabrica`
 * symlink npm wrote - the one record of which prefix put `fabrica` on
 * this `PATH` (verified against both kinds of real install). */
export function prefixOfGlobalBin(binPath: string | undefined | null): string | null {
  const path = normalizedPrefix(binPath);
  if (path === null) return null;
  const bin = dirname(path);
  if (basename(bin) !== "bin") return null;
  const prefix = dirname(bin);
  return prefix === bin ? null : prefix;
}

/** Where a prefix keeps its copy of this package: a real directory for
 * an installed copy, a symlink to a checkout for an `npm link`ed one. */
export function globalPackagePath(prefix: string): string {
  return join(prefix, "lib", "node_modules", GLOBAL_PACKAGE_NAME);
}

/** Where Fabrica's own code comes from, over plain https: the one
 * spelling shared by every command that reads or clones it (this
 * module's clone step, and `fabrica doctor`'s side-effect-free
 * `git ls-remote` against master). */
export const UPSTREAM_GIT_URL = "https://github.com/inactdev/fabrica.git";

/** The branch an install or an update takes its code from - the same one
 * `fabrica doctor` reports a copy against and `fabrica update` pulls a
 * dev checkout from. */
export const UPSTREAM_BRANCH = "master";

/** Step one of installing or replacing a copy: clone the repository into
 * a throwaway directory.
 *
 * This step exists for one reason: `.git`. A *hosted* GitHub spec
 * (`github:inactdev/fabrica`, and every `git+https`/`git+ssh` spelling
 * of it, which npm resolves to the same codeload tarball) is fetched as
 * GitHub's tarball of the tree, so the package's `prepare` script runs
 * somewhere with no `.git` and no commit in any field npm sets - and the
 * copy that gets installed cannot say which commit it is
 * (`scripts/write-build-info.mjs`). A real clone has `.git`, so packing
 * from inside it records the commit exactly as a developer checkout
 * does. `--depth 1` because only HEAD is ever read; `--branch` names the
 * line being installed rather than trusting whatever the remote's
 * default happens to be. */
export function cloneCommandArgs(destination: string): string[] {
  return ["clone", "--depth", "1", "--branch", UPSTREAM_BRANCH, UPSTREAM_GIT_URL, destination];
}

/** Step two: build the published tarball from inside that clone.
 *
 * `--pack-destination` is npm's own documented flag for choosing where
 * the tarball lands ("Directory in which `npm pack` will save tarballs",
 * `commands/npm-pack.md`); `--prefix` is deliberately absent, since npm
 * forces a *non-global* command to run inside whatever `--prefix` names
 * on the command line, and `pack` is one. No spec is named either - the
 * clone itself is the package being packed, which is what makes its
 * `.git` the one the `prepare` script sees. No `--ignore-scripts`: that
 * `prepare` run is what puts `build-info.json` - the commit `fabrica
 * doctor` reads off an installed copy - into the tarball at all. */
export function packInCloneCommandArgs(destination: string): string[] {
  return ["pack", "--pack-destination", destination];
}

/** Step three: install that tarball globally. Carries `--prefix`
 * whenever the prefix to install into is known, since npm's own default
 * global prefix is read-only on some hosts; `null` falls back to that
 * default, which is all anyone can say when nothing names a prefix.
 *
 * A local file, never a git spec - a git spec installed globally leaves
 * the package a symlink into a clone npm then deletes (see
 * global-reinstall.ts), while a tarball unpacks into a real directory. */
export function installTarballCommandArgs(prefix: string | null, tarball: string): string[] {
  return prefix === null
    ? ["install", "-g", tarball]
    : ["install", "-g", "--prefix", prefix, tarball];
}

/** The three steps above as one line a person can paste into a shell -
 * what README.md's "Installing the command" tells a Client to run, and
 * what `fabrica doctor` names as the fix for an installed copy that does
 * not know its commit. Built from the very argv `fabrica update` itself
 * runs, so the printed procedure and the performed one cannot drift.
 *
 * `mktemp -d` rather than a fixed path: the directory is throwaway, and
 * naming a fixed one would collide with whatever is already there. The
 * tarball is named with a `*` glob because its version comes from the
 * `package.json` being packed - a person's shell expands that, which is
 * exactly why the code path reads the directory instead
 * (`isPackedTarball`). */
export function clonePackInstallProcedure(prefix: string | null): string {
  const clone = `"$d/${GLOBAL_PACKAGE_NAME}"`;
  return [
    "d=$(mktemp -d)",
    `git ${cloneCommandArgs(clone).join(" ")}`,
    `(cd ${clone} && npm ${packInCloneCommandArgs('"$d"').join(" ")})`,
    `npm ${installTarballCommandArgs(prefix, `"$d"/${GLOBAL_PACKAGE_NAME}-*.tgz`).join(" ")}`,
  ].join(" && ");
}

/** Whether a file name in the pack destination is the tarball npm just
 * wrote for this package. npm names a packed tarball
 * `<name>-<version>.tgz` (`fabrica-0.0.0.tgz`), so the version is
 * whatever `package.json` says at the commit being packed - never
 * assumed here, only the name and the extension. */
export function isPackedTarball(fileName: string): boolean {
  return fileName.startsWith(`${GLOBAL_PACKAGE_NAME}-`) && fileName.endsWith(".tgz");
}
