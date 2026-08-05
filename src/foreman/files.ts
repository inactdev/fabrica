// Lists the files a worker actually touched inside a ProductionLine, for
// the delivery's `files` field. `git status --porcelain` in one call
// covers staged, unstaged, and untracked files — everything a worker
// could have done to the worktree without committing.

import { execFileSync } from "node:child_process";

export function listTouchedFiles(workdir: string): string[] {
  const raw = execFileSync("git", ["status", "--porcelain"], {
    cwd: workdir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const files: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    // Porcelain format: two status chars, a space, then the path (a
    // rename entry reads "old -> new"; keep the new path).
    const path = line.slice(3);
    const arrow = path.indexOf(" -> ");
    files.push(arrow === -1 ? path : path.slice(arrow + 4));
  }
  return files;
}
