// The read side of events.jsonl. Every call reads the file fresh and
// parses it into new objects, so nothing a caller does to the returned
// array or its entries can reach back into the record (rule 5).

import { readFileSync } from "node:fs";
import { recordPath } from "./append.ts";
import type { RecordEvent } from "./types.ts";

/** Every event ever recorded at this home, oldest first. */
export function readEvents(home: string): RecordEvent[] {
  let text: string;
  try {
    text = readFileSync(recordPath(home), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RecordEvent);
}

/** Every event for one task, in the order they were recorded. */
export function readEventsForTask(home: string, taskId: string): RecordEvent[] {
  return readEvents(home).filter((event) => event.taskId === taskId);
}
