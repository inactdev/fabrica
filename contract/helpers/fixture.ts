// Builds a tiny throwaway git repository for contract tests, with a
// configurable check command, and can fingerprint a directory so rule 1
// can prove the Client's checkout was untouched, byte for byte.

import { execFileSync, execSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

/** The Inspector config every fixture carries unless asked not to, so a
 * task on it is judged by Inspector (a fake one in tests - see
 * fake-inspector.ts). `{ inspector: false }` leaves it out, for the
 * self-tested path where no Inspector is configured. */
export const FIXTURE_INSPECTOR_CONFIG = '{"check":"./check.sh","image":"alpine"}\n';

/** Points `dir`'s "origin" remote at a fresh bare mirror of its current
 * branch, with that mirror's own HEAD symref set to match - so
 * `git ls-remote --symref origin HEAD` (what createProductionLine reads
 * to find origin's default branch, see src/line/cut.ts) resolves the same
 * way a real, properly-configured remote would. A bare repo's HEAD
 * otherwise defaults to "refs/heads/master" regardless of what was
 * actually pushed, which leaves the symref dangling when the fixture's
 * own default branch is named something else (e.g. "main"). */
export function addOrigin(dir: string): void {
  const branch = execFileSync("git", ["branch", "--show-current"], { cwd: dir, encoding: "utf8" }).trim();
  const bare = mkdtempSync(join(tmpdir(), "fabrica-fixture-origin-"));
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["remote", "add", "origin", bare], { cwd: dir });
  execFileSync("git", ["push", "-q", "origin", branch], { cwd: dir });
  execFileSync("git", ["symbolic-ref", "HEAD", `refs/heads/${branch}`], { cwd: bare });
}

/** Pushes `dir`'s current branch to its already-configured "origin" (see
 * addOrigin) - for a test that commits something into the project
 * *after* fixture creation and needs that commit to be what
 * createProductionLine's origin fetch actually sees. */
export function pushToOrigin(dir: string): void {
  const branch = execFileSync("git", ["branch", "--show-current"], { cwd: dir, encoding: "utf8" }).trim();
  execFileSync("git", ["push", "-q", "origin", branch], { cwd: dir });
}

export function makeFixtureRepo(checkCmd = "exit 0", opts: { inspector?: boolean; origin?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-fixture-"));
  writeFileSync(join(dir, "app.txt"), "hello from the fixture app\n");
  writeFileSync(join(dir, "check.sh"), `#!/bin/sh\n${checkCmd}\n`);
  if (opts.inspector !== false) writeFileSync(join(dir, ".inspector.json"), FIXTURE_INSPECTOR_CONFIG);
  execSync("chmod +x check.sh", { cwd: dir });
  execSync("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init", {
    cwd: dir,
    shell: "/bin/bash",
  });
  if (opts.origin !== false) addOrigin(dir);
  return dir;
}

/** Stable fingerprint of every file under dir (skipping .git internals). */
export function fingerprint(dir: string): string {
  const hash = createHash("sha256");
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name === ".git") continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else {
        hash.update(p.slice(dir.length));
        hash.update(readFileSync(p));
      }
    }
  };
  walk(dir);
  return hash.digest("hex");
}
