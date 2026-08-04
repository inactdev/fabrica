// Cuts a fresh ProductionLine: a disposable git worktree of the project on
// a new branch `fabrica/<id>` (CONTRACT rule 1). `git worktree add` only
// ever reads the Client's checkout and records the new worktree in the
// project's own .git metadata — it never writes into the Client's working
// files, so the checkout stays untouched by construction.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { LineError } from "./errors.ts";
import type { ProductionLine } from "./types.ts";
import { assertSafeId, describeGitError, requireRepoRoot } from "./safety.ts";

export function cutLine(opts: { project: string; id: string; home: string }): ProductionLine {
  assertSafeId(opts.id);
  const project = requireRepoRoot(opts.project);

  let home: string;
  try {
    home = realpathSync(opts.home);
  } catch {
    throw new LineError("home-not-found", `Record home ${opts.home} does not exist.`);
  }

  const workdir = join(home, "tasks", opts.id, "worktree");
  if (existsSync(workdir)) {
    throw new LineError(
      "workdir-exists",
      `A ProductionLine workspace already exists at ${workdir}. Refusing to ` +
        `reuse or overwrite it — task ids must be unique.`
    );
  }

  mkdirSync(join(home, "tasks", opts.id), { recursive: true });

  const branch = `fabrica/${opts.id}`;
  try {
    execFileSync("git", ["worktree", "add", "-b", branch, workdir, "HEAD"], {
      cwd: project,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new LineError(
      "cut-failed",
      `Could not cut a ProductionLine for ${branch} from ${project}: ${describeGitError(err)}`
    );
  }

  return { id: opts.id, branch, project, workdir, home };
}
