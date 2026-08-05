// events.jsonl: the single source of truth (SPEC.md "The record").
// Append-only, one JSON object per line. This is the ONLY way to add to
// the record — there is deliberately no update or delete path anywhere in
// this module (rule 5: "old entries can never be changed or erased
// through Fabrica").
//
// Atomicity: each call opens the file with O_APPEND and writes the whole
// line in a single write() syscall, so concurrent writers (other
// processes, not just other calls in this one) never interleave into
// each other's line. That is a concurrency guarantee, not a durability
// one: write() can still land short (e.g. the disk filling mid-write),
// so appendEvent verifies the byte count and refuses to report success
// on a shortfall.

import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { RecordError } from "./errors.ts";
import type { NewFabricaEvent, FabricaEvent } from "./types.ts";

/** Absolute path of the append-only event record. */
export function recordPath(recordHome: string): string {
  return join(recordHome, "events.jsonl");
}

/** Appends one event and returns the stamped record actually written. */
export function appendEvent(recordHome: string, input: NewFabricaEvent): FabricaEvent {
  const record: FabricaEvent = { occurredAt: "", ...input };
  record.occurredAt = new Date().toISOString();
  const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");

  mkdirSync(recordHome, { recursive: true });
  const fd = openSync(recordPath(recordHome), "a");
  try {
    const written = writeSync(fd, line);
    if (written !== line.byteLength) {
      throw new RecordError(
        "short-write",
        `The record at ${recordPath(recordHome)} accepted only ${written} of ` +
          `${line.byteLength} bytes for this event (is the disk full?). ` +
          `The event was not fully written.`,
      );
    }
  } finally {
    closeSync(fd);
  }

  return record;
}
