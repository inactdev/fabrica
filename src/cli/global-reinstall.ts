// Replacing an installed copy of `fabrica` with the current code at
// `github:inactdev/fabrica` - the installed-copy half of `fabrica
// update`, as two npm commands rather than one.
//
// Why two. `npm install -g github:inactdev/fabrica` does not install a
// copy of the package at all: npm clones the repo into its own cache
// (`~/.npm/_cacache/tmp/git-clone*`), then *symlinks*
// `<prefix>/lib/node_modules/fabrica` at that clone and deletes it -
// reproduced on npm 11.16.0 / Node 24.18.0 on Linux with a `git+file://`
// spec, where the install reported "added 1 package" and the installed
// `fabrica` was immediately "No such file or directory". The Client hit
// the same thing against the real GitHub spec from the other side: a
// dependency's postinstall dying with ENOENT inside a folder npm was
// already removing, and `--ignore-scripts` leaving the dangling symlink
// behind.
//
// Packing first sidesteps all of it. `npm pack <spec>` runs the
// package's own `prepare` script and writes the published tarball (so
// `build-info.json`, the commit `fabrica doctor` reads off an installed
// copy, is in it), and installing that tarball unpacks a real directory
// with a working executable - both verified the same way, on the same
// npm. The exact commands are spelled once, in npm-prefix.ts.
//
// Everything that touches the machine is one injected interface
// (`GlobalReinstallIo`), so the tests here assert the exact argv npm is
// handed without ever running npm, making a temp directory, or reaching
// the network.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installTarballCommandArgs, isPackedTarball, packCommandArgs } from "./npm-prefix.ts";

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

/** Every step that touches the machine, injectable as one object. */
export interface GlobalReinstallIo {
  /** Runs `npm` with exactly these args. */
  npm(args: string[]): CommandOutcome;
  /** A fresh, empty directory for the tarball, which nothing else
   * writes into - so the one file in it afterwards is npm's. */
  makeStagingDir(): string;
  /** The names (not paths) of the files in it. */
  readStagingDir(dir: string): string[];
  /** Removes it, whatever happened. Must never throw: a staging
   * directory left behind is litter, not a failed update. */
  removeStagingDir(dir: string): void;
}

export const realGlobalReinstallIo: GlobalReinstallIo = {
  npm: (args) => {
    try {
      const out = execFileSync("npm", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { ok: true, message: out.trim() };
    } catch (err) {
      return { ok: false, message: commandFailureMessage(err) };
    }
  },
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

/** Packs the current code at the documented spec into a staging
 * directory, then installs that tarball into `prefix` (npm's own default
 * prefix when `null`). Reports, never throws - and a failure's message
 * names the exact npm command that produced it, so what the Client reads
 * is what he can run himself.
 *
 * The tarball is found by reading the staging directory rather than
 * passing npm a `fabrica-*.tgz` glob: npm is run directly, with no shell
 * anywhere to expand one. A directory this function just created holds
 * exactly one tarball; none at all, or more than one, is reported rather
 * than guessed at. */
export function reinstallGlobalCopy(prefix: string | null, io: GlobalReinstallIo): CommandOutcome {
  const staging = io.makeStagingDir();
  try {
    const packArgs = packCommandArgs(staging);
    const packed = io.npm(packArgs);
    if (!packed.ok) return failure(packArgs, packed.message);

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
    const installed = io.npm(installArgs);
    return installed.ok ? installed : failure(installArgs, installed.message);
  } finally {
    // Unconditional: the install copies the tarball in, so keeping it
    // afterwards serves nothing, and a failed run has no more use for it
    // than a successful one.
    io.removeStagingDir(staging);
  }
}

function failure(args: string[], message: string): CommandOutcome {
  return { ok: false, message: `npm ${args.join(" ")} failed: ${message}` };
}

function describeWrongTarballCount(tarballs: string[]): string {
  return tarballs.length === 0
    ? "wrote no fabrica tarball"
    : `wrote ${tarballs.length} tarballs (${tarballs.join(", ")})`;
}
