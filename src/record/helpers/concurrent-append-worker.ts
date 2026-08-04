// Test-only fixture: a standalone process that hammers appendEvent against
// one shared home, so the append-only tests can prove atomicity across real
// OS-level concurrency, not just interleaved async calls inside one process.
// Invoked as: tsx concurrent-append-worker.ts <home> <taskId> <count> <label>

import { appendEvent } from "../append.ts";

const [home, taskId, countArg, label] = process.argv.slice(2);
const count = Number(countArg);

for (let i = 0; i < count; i++) {
  appendEvent(home, { taskId, name: "concurrent-write", details: { label, i } });
}
