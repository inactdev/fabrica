// Installing a copy of `fabrica` from the current code on master - the
// installed-copy half of `fabrica update`, as three commands rather than
// one.
//
// Why not one `npm install -g github:inactdev/fabrica`. That form does
// not install a copy of the package at all: npm clones the repo into its
// own cache (`~/.npm/_cacache/tmp/git-clone*`), then *symlinks*
// `<prefix>/lib/node_modules/fabrica` at that clone and deletes it -
// reproduced on npm 11.16.0 / Node 24.18.0 on Linux with a `git+file://`
// spec, where the install reported "added 1 package" and the installed
// `fabrica` was immediately "No such file or directory". The Client hit
// the same thing against the real GitHub spec from the other side: a
// dependency's postinstall dying with ENOENT inside a folder npm was
// already removing, and `--ignore-scripts` leaving the dangling symlink
// behind.
//
// Why not `npm pack github:inactdev/fabrica` either, which is what this
// did until the commit became the point. npm fetches a *hosted* GitHub
// spec as GitHub's own tarball of the tree, which carries no `.git`, so
// the `prepare` script runs with nothing to read the commit from and the
// installed copy cannot say which commit it is (verified: that tarball's
// `build-info.json` was `{"commit":null}`). Cloning first puts a real
// `.git` where `prepare` runs, so the tarball carries the commit and
// `fabrica doctor` can report it.
//
// So: clone into a throwaway directory, pack from inside the clone,
// install that tarball. The exact commands are spelled once, in
// npm-prefix.ts.
//
// Everything that touches the machine is one injected interface
// (`GlobalReinstallIo`), so the tests here assert the exact argv git and
// npm are handed, and the directory each is run in, without ever running
// either, making a temp directory, or reaching the network.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GLOBAL_PACKAGE_NAME,
  cloneCommandArgs,
  installTarballCommandArgs,
  isPackedTarball,
  packInCloneCommandArgs,
} from "./npm-prefix.ts";

/** How a command that was run reports itself: whether it worked, and
 * the one string worth showing the Client either way - the same shape
 * `UpdateProbes`'s own actions use. */
export interface CommandOutcome {
  ok: boolean;
  message: string;
}

/** The message a failed `execFileSync` should be reported with: what the
 * command itself said on stderr whenever it said anything, since that is
 * the real reason, and node's own wrapper message only otherwise. */
export function commandFailureMessage(err: unknown): string {
  const e = err as { stderr?: Buffer | string; message?: string };
  if (e?.stderr) return e.stderr.toString().trim();
  return e?.message ?? String(err);
}

/** Every step that touches the machine, injectable as one object. Both
 * command runners take the directory to run in: npm's own notion of
 * where it is matters here (the pack step must run inside the clone for
 * that clone to be the package it packs), and a global install run from
 * a directory npm cannot read a `package.json` in has been seen to fail
 * with an ENOENT about that file. */
export interface GlobalReinstallIo {
  /** Runs `npm` with exactly these args, in `cwd`. */
  npm(args: string[], cwd: string): CommandOutcome;
  /** Runs `git` with exactly these args, in `cwd`. */
  git(args: string[], cwd: string): CommandOutcome;
  /** A fresh, empty directory to clone and pack into, which nothing else
   * writes into - so the one tarball in it afterwards is npm's. */
  makeStagingDir(): string;
  /** The names (not paths) of the files in it. */
  readStagingDir(dir: string): string[];
  /** Removes it, whatever happened. Must never throw: a staging
   * directory left behind is litter, not a failed update. */
  removeStagingDir(dir: string): void;
}

function run(command: string, args: string[], cwd: string): CommandOutcome {
  try {
    const out = execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, message: out.trim() };
  } catch (err) {
    return { ok: false, message: commandFailureMessage(err) };
  }
}

export const realGlobalReinstallIo: GlobalReinstallIo = {
  npm: (args, cwd) => run("npm", args, cwd),
  git: (args, cwd) => run("git", args, cwd),
  makeStagingDir: () => mkdtempSync(join(tmpdir(), "fabrica-update-")),
  readStagingDir: (dir) => readdirSync(dir),
  removeStagingDir: (dir) => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Litter in the temp directory the OS clears anyway - never worth
      // turning a finished update into a failure over.
    }
  },
};

/** Where inside the staging directory the clone goes. A name of our own,
 * so the tarball npm writes beside it is never mistaken for part of it
 * and vice versa. */
const CLONE_DIR_NAME = GLOBAL_PACKAGE_NAME;

/** Clones master into a staging directory, packs the published tarball
 * from inside that clone, then installs the tarball into `prefix` (npm's
 * own default prefix when `null`). Reports, never throws - and a
 * failure's message names the exact command that produced it, so what
 * the Client reads is what he can run himself.
 *
 * The tarball is found by reading the staging directory rather than
 * passing npm a `fabrica-*.tgz` glob: npm is run directly, with no shell
 * anywhere to expand one. A directory this function just created holds
 * exactly one tarball; none at all, or more than one, is reported rather
 * than guessed at. */
export function reinstallGlobalCopy(prefix: string | null, io: GlobalReinstallIo): CommandOutcome {
  const staging = io.makeStagingDir();
  const clone = join(staging, CLONE_DIR_NAME);
  try {
    const cloneArgs = cloneCommandArgs(clone);
    const cloned = io.git(cloneArgs, staging);
    if (!cloned.ok) return failure("git", cloneArgs, cloned.message);

    const packArgs = packInCloneCommandArgs(staging);
    const packed = io.npm(packArgs, clone);
    if (!packed.ok) return failure("npm", packArgs, packed.message);

    const tarballs = io.readStagingDir(staging).filter(isPackedTarball);
    if (tarballs.length !== 1) {
      return {
        ok: false,
        message:
          `npm ${packArgs.join(" ")} ${describeWrongTarballCount(tarballs)} - ` +
          `there is no one tarball to install fabrica from, so nothing was installed`,
      };
    }

    const installArgs = installTarballCommandArgs(prefix, join(staging, tarballs[0]));
    const installed = io.npm(installArgs, clone);
    return installed.ok ? installed : failure("npm", installArgs, installed.message);
  } finally {
    // Unconditional: the install copies the tarball in, so keeping it
    // afterwards serves nothing, and a failed run has no more use for it
    // than a successful one.
    io.removeStagingDir(staging);
  }
}

function failure(command: string, args: string[], message: string): CommandOutcome {
  return { ok: false, message: `${command} ${args.join(" ")} failed: ${message}` };
}

function describeWrongTarballCount(tarballs: string[]): string {
  return tarballs.length === 0
    ? "wrote no fabrica tarball"
    : `wrote ${tarballs.length} tarballs (${tarballs.join(", ")})`;
}
