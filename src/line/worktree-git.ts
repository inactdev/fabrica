// Resolves a ProductionLine workdir's real git directory - the shared
// object database and refs every worktree points back to - straight
// from the worktree's own `.git` pointer file, without needing the
// `ProductionLine` object itself (only `workdir`, which is all a `Brain`
// adapter's `work(brief, workdir, opts)` ever receives - contract/
// surface.ts's `Brain` interface has no room to also pass `project` or
// `taskId` through).
//
// `git worktree add` always leaves `<workdir>/.git` as a one-line
// pointer file, `gitdir: <project>/.git/worktrees/<taskId>` - a real,
// absolute host path outside `workdir` entirely. That file's own
// `commondir` (relative to it) names the actual shared `.git` - the
// object database, refs, and config every worktree of the same project
// shares. This is what a contained process needs mounted (read-only) to
// use git at all; see src/containment/README.md and this project's
// AGENTS.md for why.

import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LineError } from "./errors.ts";

export function resolveCommonGitDir(workdir: string): string {
  const pointerPath = join(workdir, ".git");
  let pointer: string;
  try {
    pointer = readFileSync(pointerPath, "utf8").trim();
  } catch (err) {
    throw new LineError(
      "not-a-worktree",
      `"${pointerPath}" could not be read - is ${workdir} a ProductionLine worktree? ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const match = pointer.match(/^gitdir: (.+)$/);
  if (!match) {
    throw new LineError(
      "not-a-worktree",
      `"${pointerPath}" is not a git worktree pointer file (expected "gitdir: <path>", found "${pointer}")`
    );
  }
  // git 2.48+ can write a relative gitdir here (worktree.useRelativePaths
  // / extensions.relativeWorktrees), resolved relative to the pointer
  // file's own directory - never the process's cwd.
  const worktreeGitDir = resolve(workdir, match[1]);

  let commondir: string;
  try {
    commondir = readFileSync(join(worktreeGitDir, "commondir"), "utf8").trim();
  } catch (err) {
    throw new LineError(
      "not-a-worktree",
      `"${worktreeGitDir}/commondir" could not be read: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const commonGitDir = resolve(worktreeGitDir, commondir);
  try {
    return realpathSync(commonGitDir);
  } catch (err) {
    throw new LineError(
      "not-a-worktree",
      `"${commonGitDir}" (the shared .git this worktree points to) does not resolve to a real, existing path: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

// The shared .git's `config` is the one file in it that can carry a
// credential: a remote URL like https://user:token@host/repo.git, or a
// credential-helper setting. A contained process that can read it (and
// is allowed network) could push with that credential - so the config
// mounted into a container must never be the real one. This writes a
// throwaway sanitized copy with every [remote "..."] section (header
// and body) stripped, for the caller to shadow-mount over the real
// config's path and delete after the call. Stripping only remote
// sections, not the whole file, is deliberate: git refuses to detect a
// repository with no config at all ("fatal: not a git repository:
// (null)", verified live), while a config keeping [core] and the rest
// leaves status/log/diff working normally.
export function writeSanitizedGitConfig(commonGitDir: string): string {
  let config: string;
  try {
    config = readFileSync(join(commonGitDir, "config"), "utf8");
  } catch (err) {
    throw new LineError(
      "not-a-worktree",
      `"${commonGitDir}/config" could not be read: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const kept: string[] = [];
  let inRemoteSection = false;
  for (const line of config.split("\n")) {
    const header = line.match(/^\s*\[\s*([^\s\]"]+)/);
    if (header) inRemoteSection = header[1].toLowerCase() === "remote";
    if (!inRemoteSection) kept.push(line);
  }

  const dir = mkdtempSync(join(realpathSync(tmpdir()), "fabrica-sanitized-git-config-"));
  const sanitizedPath = join(dir, "config");
  writeFileSync(sanitizedPath, kept.join("\n"));
  return sanitizedPath;
}
