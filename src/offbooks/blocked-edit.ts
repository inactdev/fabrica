// Records a blocked file-edit attempt (SPEC.md "Catching off-the-books
// work": "the session setup also logs every blocked edit attempt as an
// edit-attempt-blocked event"). Called by each harness's own blocked-edit
// hook script under skill/<harness>/hooks/ — kept here, not duplicated
// there, so there is exactly one definition of what this event looks
// like, shared with unattributed-change's "project:<name>" taskId
// convention (detect.ts) for the same reason: no task is involved, so
// both key off the registered project instead.

import { resolve, sep } from "node:path";
import { loadConfig } from "../config/index.ts";
import { appendEvent } from "../record/index.ts";

export interface BlockedEditAttempt {
  tool: string;
  /** The file path (Edit/Write/NotebookEdit) or shell command (Bash) the
   * blocked call carried, when the hook payload provided one. */
  target?: string;
  cwd: string;
  reason?: string;
}

/** Which registered project (if any) `cwd` falls under, so this event
 * keys the same way unattributed-change's does. Null when `cwd` isn't
 * inside any registered project (or projects.toml can't be read at all —
 * never thrown, this is a courtesy lookup, not a gate). */
function resolveProjectName(recordHome: string, cwd: string): string | null {
  let projects: Record<string, { path: string }>;
  try {
    projects = loadConfig(recordHome).projects;
  } catch {
    return null;
  }

  const resolvedCwd = resolve(cwd);
  for (const [name, project] of Object.entries(projects)) {
    const projectPath = resolve(project.path);
    if (resolvedCwd === projectPath || resolvedCwd.startsWith(`${projectPath}${sep}`)) return name;
  }
  return null;
}

export function recordBlockedEditAttempt(recordHome: string, attempt: BlockedEditAttempt): void {
  const projectName = resolveProjectName(recordHome, attempt.cwd);
  appendEvent(recordHome, {
    taskId: projectName ? `project:${projectName}` : "project:unregistered",
    name: "edit-attempt-blocked",
    details: {
      project: projectName,
      tool: attempt.tool,
      target: attempt.target,
      cwd: attempt.cwd,
      reason: attempt.reason,
    },
  });
}
