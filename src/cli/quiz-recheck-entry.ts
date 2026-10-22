// The real program spawnDetachedResume's "quiz-recheck" kind runs as the
// detached child - the same parent-records-then-child-runs split
// answer-entry.ts and verdict-fix-entry.ts already have. The parent
// (verdict-command.ts, or the live view's verdict route) has already
// recorded the accept and marked whichever earlier tasks' quiz questions
// may now be out of date; this only runs the re-check rounds those marks
// asked for, re-deriving the whole outstanding set from recordHome alone.
//
// No pid file: unlike an answer or a fix, this is not a round of the
// task's own work, so `fabrica stop` has nothing here to stop and must
// not be pointed at it.

import { defaultBrainAdapter, runQuizRecheck } from "../index.ts";
import { loadConfigOrDefault } from "./load-config.ts";

const [, , recordHome] = process.argv;

if (recordHome === undefined) {
  console.error(`fabrica (detached quiz re-check runner): expected <recordHome>, got ${process.argv.length - 2} argument(s).`);
  process.exit(1);
}

try {
  const run = await runQuizRecheck(recordHome, {
    brain: defaultBrainAdapter(recordHome),
    caps: loadConfigOrDefault(recordHome).caps,
  });
  if (run.skipped) console.log(`fabrica quiz re-check: nothing to do - ${run.skipped}`);
  for (const note of run.notes) console.log(`fabrica quiz re-check: ${note}`);
  if (run.deferred > 0) {
    console.log(`fabrica quiz re-check: ${run.deferred} more task(s) still marked outdated - the next accept picks them up.`);
  }
} catch (err) {
  console.error(`fabrica quiz re-check: failed: ${(err as Error).message}`);
  process.exit(1);
}
