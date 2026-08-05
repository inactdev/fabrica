// Creates a fresh ProductionLine: a disposable git worktree of the project
// on a new branch `fabrica/<taskId>` (CONTRACT rule 1). `git worktree add`
// only ever reads the Client's checkout and records the new worktree in
// the project's own .git metadata — it never writes into the Client's
// working files, so the checkout stays untouched by construction.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { LineError } from "./errors.ts";
import type { ProductionLine } from "../../contract/surface.ts";
import { assertSafeId, describeGitError, requireRepoRoot } from "./safety.ts";

export function createProductionLine(opts: { project: string; taskId: string; recordHome: string }): ProductionLine {
  assertSafeId(opts.taskId);
  const project = requireRepoRoot(opts.project);

  let recordHome: string;
  try {
    recordHome = realpathSync(opts.recordHome);
  } catch {
    throw new LineError("home-not-found", `Record home ${opts.recordHome} does not exist.`);
  }

  const workdir = join(recordHome, "tasks", opts.taskId, "worktree");
  if (existsSync(workdir)) {
    throw new LineError(
      "workdir-exists",
      `A ProductionLine workspace already exists at ${workdir}. Refusing to ` +
        `reuse or overwrite it — task ids must be unique.`
    );
  }

  mkdirSync(join(recordHome, "tasks", opts.taskId), { recursive: true });

  const branch = `fabrica/${opts.taskId}`;
  try {
    execFileSync("git", ["worktree", "add", "-b", branch, workdir, "HEAD"], {
      cwd: project,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new LineError(
      "cut-failed",
      `Could not create a ProductionLine for ${branch} from ${project}: ${describeGitError(err)}`
    );
  }

  return { taskId: opts.taskId, branch, project, workdir, recordHome };
}
