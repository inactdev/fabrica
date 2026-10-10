// Builds a tiny throwaway git repository for contract tests, with a
// configurable check command, and can fingerprint a directory so rule 1
// can prove the Client's checkout was untouched, byte for byte.

import { execSync } from "node:child_process";
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

export function makeFixtureRepo(checkCmd = "exit 0", opts: { inspector?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-fixture-"));
  writeFileSync(join(dir, "app.txt"), "hello from the fixture app\n");
  writeFileSync(join(dir, "check.sh"), `#!/bin/sh\n${checkCmd}\n`);
  if (opts.inspector !== false) writeFileSync(join(dir, ".inspector.json"), FIXTURE_INSPECTOR_CONFIG);
  execSync("chmod +x check.sh", { cwd: dir });
  execSync("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init", {
    cwd: dir,
    shell: "/bin/bash",
  });
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
