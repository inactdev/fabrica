// Test-only entry point: creates one ProductionLine and prints it as JSON.
// Invoked as a separate OS process (via tsx) so the concurrency test can
// prove two real, simultaneous `git worktree add` calls against the same
// project don't collide — something an in-process, single-threaded test
// can't exercise.
//
// Usage: tsx cut-in-subprocess.ts <project> <taskId> <recordHome>

import { createProductionLine } from "../cut.ts";

const [project, taskId, recordHome] = process.argv.slice(2);
const line = createProductionLine({ project, taskId, recordHome });
process.stdout.write(JSON.stringify(line));
