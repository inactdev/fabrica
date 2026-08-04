// events.jsonl: the single source of truth (SPEC.md "The record").
// Append-only, one JSON object per line. This is the ONLY way to add to
// the record — there is deliberately no update or delete path anywhere in
// this module (rule 5: "old entries can never be changed or erased
// through Fabrica").
//
// Atomicity: each call opens the file with O_APPEND and writes the whole
// line in a single write() syscall. On a local filesystem that write
// either lands in full or not at all — a crash mid-write cannot leave a
// torn line, and O_APPEND means concurrent writers (other processes, not
// just other calls in this one) never interleave into each other's line.

import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { NewRecordEvent, RecordEvent } from "./types.ts";

/** Absolute path of the append-only event record. */
export function recordPath(home: string): string {
  return join(home, "events.jsonl");
}

/** Appends one event and returns the stamped record actually written. */
export function appendEvent(home: string, input: NewRecordEvent): RecordEvent {
  const record: RecordEvent = { occurredAt: "", ...input };
  record.occurredAt = new Date().toISOString();
  const line = `${JSON.stringify(record)}\n`;

  mkdirSync(home, { recursive: true });
  const fd = openSync(recordPath(home), "a");
  try {
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }

  return record;
}
