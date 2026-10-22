// Test-only stand-in for quiz-recheck-entry.ts: same argv contract
// (<recordHome> [taskId]), but runs the re-check against fakeBrain
// instead of the real default adapter - so a test can exercise the real
// spawn-then-detach mechanism, in a real separate process, without ever
// invoking a real coding agent. Same shape as fake-verdict-fix-entry.ts
// for `fabrica verdict fix`.
//
// It also drops a marker file naming the record home it was given, so a
// test can prove the handoff happened at all: a re-check that found
// nothing to do records nothing, which is otherwise indistinguishable
// from never having been spawned.
//
// The fake worker answers by writing `quiz-recheck.json` into whatever
// workdir it is handed, confirming every question it was asked about -
// the real protocol (src/quiz/recheck.ts), with a stand-in judgment.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeBrain } from "../../brain/helpers/fake-brain.ts";
import { QUIZ_RECHECK_RESULT_FILE, runQuizRecheck } from "../../quiz/index.ts";

/** Where the marker lands, so a test knows where to look. */
export const QUIZ_RECHECK_MARKER = "fake-quiz-recheck.marker";

const [, , recordHome] = process.argv;

writeFileSync(join(recordHome, QUIZ_RECHECK_MARKER), recordHome);

const brain = fakeBrain({
  costUsd: 0,
  onWork: (brief, workdir) => {
    const indexes = [...brief.matchAll(/\[index (\d+)\]/g)].map((match) => Number(match[1]));
    writeFileSync(
      join(workdir, QUIZ_RECHECK_RESULT_FILE),
      JSON.stringify({
        verdicts: indexes.map((index) => ({ index, outcome: "confirmed", note: "a fake re-check confirmed it" })),
      })
    );
  },
});

try {
  const run = await runQuizRecheck(recordHome, { brain });
  console.log(`fake-quiz-recheck-entry: ${run.skipped ?? run.notes.join("; ")}`);
} catch (err) {
  console.error(`fake-quiz-recheck-entry: ${(err as Error).message}`);
  process.exit(1);
}
