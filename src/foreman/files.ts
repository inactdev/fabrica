// Lists the files a worker actually touched inside a ProductionLine, for
// the delivery's `files` field. `git status --porcelain` in one call
// covers staged, unstaged, and untracked files — everything a worker
// could have done to the worktree without committing.

import { execFileSync } from "node:child_process";

export function listTouchedFiles(workdir: string): string[] {
  // -z gives NUL-separated, never-quoted paths — without it, git C-quotes
  // paths with quotes, backslashes, or (by default) non-ASCII bytes.
  const raw = execFileSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], {
    cwd: workdir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const files: string[] = [];
  const entries = raw.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length === 0) continue;
    // Each entry is two status chars, a space, then the path. A rename or
    // copy entry's new path comes first, with the old path as the next
    // NUL-separated field; keep the new path and skip the old.
    files.push(entry.slice(3));
    if ("RC".includes(entry[0]) || "RC".includes(entry[1])) i++;
  }
  return files;
}
