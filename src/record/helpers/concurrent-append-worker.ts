// Test-only fixture: a standalone process that hammers appendEvent against
// one shared record home, so the append-only tests can prove atomicity
// across real OS-level concurrency, not just interleaved async calls
// inside one process.
// Invoked as: tsx concurrent-append-worker.ts <recordHome> <taskId> <count> <label>

import { appendEvent } from "../append.ts";

const [recordHome, taskId, countArg, label] = process.argv.slice(2);
const count = Number(countArg);

for (let i = 0; i < count; i++) {
  appendEvent(recordHome, { taskId, name: "concurrent-write", details: { label, i } });
}
