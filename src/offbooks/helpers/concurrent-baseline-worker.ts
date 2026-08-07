// Test-only fixture: a standalone process that rewrites one project's
// baseline over and over, so baseline.test.ts can prove a reader never
// catches a half-written file across real OS-level concurrency — the same
// reasoning src/record/helpers/concurrent-append-worker.ts is built on.
// Invoked as: tsx concurrent-baseline-worker.ts <recordHome> <project> <count> <label>

import { writeBaseline } from "../baseline.ts";

const [recordHome, projectName, countArg, label] = process.argv.slice(2);
const count = Number(countArg);

for (let i = 0; i < count; i++) {
  writeBaseline(recordHome, projectName, {
    branch: "main",
    headCommit: `${label}${i}`.padEnd(40, "0").slice(0, 40),
    dirty: Array.from({ length: 2000 }, (_, n) => ` M ${label}-${i}-file-${n}.txt`),
  });
}
