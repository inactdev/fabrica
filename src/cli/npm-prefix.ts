// npm's global install layout, as the three facts the `fabrica` command
// needs from it: which prefix a given copy of this package is installed
// under, which prefix the executable on `PATH` came from, and - the
// reverse - where any prefix keeps its copy of this package. Plus the
// npm commands those prefixes are for, each spelled exactly once - the
// documented install a person runs (`installCommandArgs`) and the two
// `fabrica update` runs to replace an installed copy in place
// (`packCommandArgs`, `installTarballCommandArgs`) - since a command
// that is printed in one place and run in another must be the same
// command.
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

/** What README.md's "Installing the command" tells a Client to run. */
export const INSTALL_SPEC = "github:inactdev/fabrica";

/** The documented install command, as one spelling shared by everything
 * that prints it - `fabrica doctor`'s own "reinstall with" fix, and the
 * advice a copy that can't be updated in place is given - so none of
 * them can drift from the others. Carries `--prefix` whenever the prefix
 * to install into is known, since npm's default is read-only on some
 * hosts; `null` falls back to npm's default, which is all anyone can say
 * when nothing names a prefix.
 *
 * This is the command a *person* runs, from README.md. It is no longer
 * what `fabrica update` itself runs: installing a git spec globally
 * leaves the package a symlink into npm's own clone directory, which npm
 * then deletes (see global-reinstall.ts), so updating in place packs
 * first and installs the tarball - `packCommandArgs` plus
 * `installTarballCommandArgs` below. */
export function installCommandArgs(prefix: string | null): string[] {
  return prefix === null
    ? ["install", "-g", INSTALL_SPEC]
    : ["install", "-g", "--prefix", prefix, INSTALL_SPEC];
}

/** Step one of updating an installed copy: build the published tarball
 * from the documented spec into a directory of our own choosing.
 *
 * `--pack-destination` is npm's own documented flag for that
 * ("Directory in which `npm pack` will save tarballs",
 * `commands/npm-pack.md`); `--prefix` is deliberately absent, since npm
 * forces a *non-global* command to run inside whatever `--prefix` names
 * on the command line, and `pack` is one. No `--ignore-scripts` either:
 * packing a git spec runs the package's `prepare` script first (npm's
 * documented behaviour for git dependencies, verified), which is what
 * puts `build-info.json` - the commit `fabrica doctor` reads off an
 * installed copy - into the tarball at all. */
export function packCommandArgs(destination: string): string[] {
  return ["pack", INSTALL_SPEC, "--pack-destination", destination];
}

/** Step two: install that tarball globally. Same `--prefix` rule as
 * `installCommandArgs` - named whenever it is known, npm's default
 * otherwise - and the only difference is what is being installed: a
 * local file, which npm unpacks into a real directory, instead of a git
 * spec, which it symlinks to a clone it is about to delete. */
export function installTarballCommandArgs(prefix: string | null, tarball: string): string[] {
  return prefix === null
    ? ["install", "-g", tarball]
    : ["install", "-g", "--prefix", prefix, tarball];
}

/** Whether a file name in the pack destination is the tarball npm just
 * wrote for this package. npm names a packed tarball
 * `<name>-<version>.tgz` (`fabrica-0.0.0.tgz`), so the version is
 * whatever `package.json` says at the commit being packed - never
 * assumed here, only the name and the extension. */
export function isPackedTarball(fileName: string): boolean {
  return fileName.startsWith(`${GLOBAL_PACKAGE_NAME}-`) && fileName.endsWith(".tgz");
}
