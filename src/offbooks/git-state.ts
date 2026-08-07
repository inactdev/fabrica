// Reads a registered project's current git state, deterministically: three
// plain git calls, no interpretation beyond parsing their output. `git
// status --porcelain=v1` already excludes ignored files by default (build
// artifacts, node_modules, editor scratch files that live under a
// .gitignore rule all fall out here for free) while still reporting both
// modified-tracked and untracked-but-not-ignored paths — exactly the
// "would this show up in a normal `git add -A`" line this net cares about.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { ProjectGitState } from "./types.ts";

/** Null when `path` isn't a usable git working tree right now (missing,
 * not a repo, permissions, mid-rebase weirdness, whatever) — every caller
 * treats that as "nothing to compare," never as an error to surface. */
export function readProjectGitState(path: string): ProjectGitState | null {
  if (!existsSync(path)) return null;

  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: path,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

    const headCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: path,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

    const status = execFileSync("git", ["status", "--porcelain=v1"], {
      cwd: path,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 100 * 1024 * 1024,
    });

    const dirty = status
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .sort();

    return { branch, headCommit, dirty };
  } catch {
    return null;
  }
}

/** The path a porcelain status line names — `"XY path"`, or `"XY a -> b"`
 * for a rename, where the path that matters here is the new name. */
export function pathFromPorcelainLine(line: string): string {
  const rest = line.slice(3);
  const arrow = rest.indexOf(" -> ");
  return arrow === -1 ? rest : rest.slice(arrow + 4);
}

/** Files touched between two commits of the same project — best-effort:
 * a rewritten history (rebase, force-push) can make `oldCommit` unreachable,
 * and that failure is reported as "unknown," never thrown. */
export function filesChangedBetween(path: string, oldCommit: string, newCommit: string): string[] {
  try {
    const raw = execFileSync("git", ["diff", "--name-only", "-z", oldCommit, newCommit], {
      cwd: path,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 100 * 1024 * 1024,
    });
    return raw.split("\0").filter((p) => p.length > 0);
  } catch {
    return [];
  }
}
