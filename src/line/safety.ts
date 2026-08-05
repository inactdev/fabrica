// Guards shared by createProductionLine and destroyProductionLine: refuse rather than guess whenever a
// path is not exactly what it should be. The incident this module is
// designed against was a script that wrote to a live path resolved from a
// throwaway copy — every check here exists to make that class of mistake
// structurally impossible for a ProductionLine, not just unlikely.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { LineError } from "./errors.ts";

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Task ids become path segments and branch names — both must be inert. */
export function assertSafeId(taskId: string): void {
  if (!SAFE_ID.test(taskId) || taskId.includes("..")) {
    throw new LineError(
      "invalid-id",
      `"${taskId}" is not a safe task id: it must start with a letter or digit, ` +
        `contain only letters, digits, ".", "_" or "-", and never contain "..".`
    );
  }
}

/** Confirms `projectPath` exists and is exactly the root of its git repository. */
export function requireRepoRoot(projectPath: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(projectPath);
  } catch {
    throw new LineError("not-a-repo", `${projectPath} does not exist.`);
  }

  let top: string;
  try {
    top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: resolved,
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
  } catch {
    throw new LineError("not-a-repo", `${projectPath} is not inside a git repository.`);
  }

  const topResolved = realpathSync(top);
  if (topResolved !== resolved) {
    throw new LineError(
      "not-a-repo",
      `${projectPath} is not the root of its git repository (root is ${topResolved}). ` +
        `Register the repository root, not a subdirectory.`
    );
  }
  return resolved;
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
}

/** Parses `git worktree list --porcelain`. The first entry is always the main worktree. */
export function listWorktrees(project: string): WorktreeEntry[] {
  const raw = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: project,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();

  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current?.path) entries.push({ path: current.path, branch: current.branch ?? null });
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  if (current?.path) entries.push({ path: current.path, branch: current.branch ?? null });
  return entries;
}

/** Realpath if the path still exists, else the path as-is (already absolute). */
function normalize(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Confirms `workdir` is a *linked* worktree — never the main one — that git
 * itself has registered for `project`. destroyProductionLine only ever acts on a path
 * that passes this check; it never deletes a path on say-so alone.
 */
export function requireLinkedWorktree(project: string, workdir: string): WorktreeEntry {
  const entries = listWorktrees(project);
  if (entries.length === 0) {
    throw new LineError("unsafe-teardown", `${project} reports no git worktrees at all.`);
  }

  const [main, ...linked] = entries;
  const workdirNormalized = normalize(workdir);

  if (normalize(main.path) === workdirNormalized) {
    throw new LineError(
      "unsafe-teardown",
      `Refusing to destroy ${workdir}: it is the project's own checkout, not a ProductionLine.`
    );
  }

  const match = linked.find((entry) => normalize(entry.path) === workdirNormalized);
  if (!match) {
    throw new LineError(
      "unsafe-teardown",
      `Refusing to destroy ${workdir}: git does not have it registered as a ` +
        `linked worktree of ${project}.`
    );
  }
  return match;
}

/** Best-effort human-readable detail from a failed git invocation. */
export function describeGitError(err: unknown): string {
  const stderr = (err as { stderr?: Buffer | string } | undefined)?.stderr;
  if (stderr && stderr.toString().trim().length > 0) return stderr.toString().trim();
  return err instanceof Error ? err.message : String(err);
}
