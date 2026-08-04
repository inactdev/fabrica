// Test-only entry point: cuts one ProductionLine and prints it as JSON.
// Invoked as a separate OS process (via tsx) so the concurrency test can
// prove two real, simultaneous `git worktree add` calls against the same
// project don't collide — something an in-process, single-threaded test
// can't exercise.
//
// Usage: tsx cut-in-subprocess.ts <project> <id> <home>

import { cutLine } from "../cut.ts";

const [project, id, home] = process.argv.slice(2);
const line = cutLine({ project, id, home });
process.stdout.write(JSON.stringify(line));
