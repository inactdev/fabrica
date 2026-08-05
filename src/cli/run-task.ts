// The one call the detached child process makes. Pure and testable on
// purpose: `brain` is a parameter here, not chosen inside this file, so
// tests can hand it a fake without spawning the real adapter (see
// run-task.test.ts) - `run-task-entry.ts` is the thin, untested glue
// that picks the real default adapter and calls this.
//
// This wraps do() (via createForeman, imported from src/index.ts - the
// one entry point any CLI code may import from, never an internal
// module path directly) without reshaping it in any way: do() still
// runs to completion inside one call, exactly as foreman/README.md
// documents. Detachment is entirely a property of *how this file gets
// invoked* (as a separate, unref'd, `stdio: 'ignore'` process - see
// spawn-detached.ts) - not of anything this function does differently
// from a direct `foreman.do()` call.

import { createForeman } from "../index.ts";
import type { Brain } from "../index.ts";

export async function runTask(recordHome: string, projectPath: string, taskText: string, brain: Brain): Promise<void> {
  const foreman = createForeman({ recordHome });
  await foreman.do(taskText, { project: projectPath, brain });
}
