// Read-side access to one task's record as it grows, for `fabrica watch`
// (issue #12). readTranscript and Foreman.events answer "everything so
// far" by reading their whole file, which is what `fabrica log` wants and
// what a 2Hz poll can't afford: events.jsonl carries every task the
// record home has ever seen, and a running task appends a heartbeat to it
// every 15s. A follower reads each line exactly once (src/record/tail.ts
// keeps the byte offset) and keeps this task's own history in hand, so a
// poll costs the bytes that landed since the last one.
//
// It still hands back the FULL history every call, not just the new part:
// stateOf, isQuietTooLong and the terminal notice are all derived from a
// task's whole event list, and a caller that had to stitch that together
// itself would be the same bug waiting to happen in every reader.

import { createLineTail, recordPath, taskFilePath } from "../record/index.ts";
import type { FabricaEvent } from "../record/index.ts";
import type { TranscriptEntry } from "../brain/index.ts";

export interface TaskProgress {
  /** Every transcript entry written so far, oldest first. */
  transcript: TranscriptEntry[];
  /** Every event recorded for this task so far, oldest first. */
  events: FabricaEvent[];
}

export interface TaskFollower {
  /** Everything on the record for this task as of now. */
  read(): TaskProgress;
}

/** Follows one task's transcript.log and its slice of events.jsonl. */
export function followTask(recordHome: string, taskId: string): TaskFollower {
  const transcriptTail = createLineTail(taskFilePath(recordHome, taskId, "transcript.log"));
  const eventsTail = createLineTail(recordPath(recordHome));
  const transcript: TranscriptEntry[] = [];
  const events: FabricaEvent[] = [];

  return {
    read() {
      for (const line of transcriptTail()) {
        const entry = parseLine<TranscriptEntry>(line);
        if (entry) transcript.push(entry);
      }
      for (const line of eventsTail()) {
        const event = parseLine<FabricaEvent>(line);
        if (event && event.taskId === taskId) events.push(event);
      }
      // Fresh arrays each call, so nothing a caller does to one read's
      // result shows up in the next one (rule 5, the same promise
      // readEvents makes by re-reading the file).
      return { transcript: [...transcript], events: [...events] };
    },
  };
}

/** A line that can't be parsed is skipped rather than thrown: a short
 * write (append.ts's documented full-disk case) leaves one permanently
 * incomplete line behind, and a watch that died on it would report a raw
 * JSON error instead of the task it was asked to follow. */
function parseLine<T>(line: string): T | null {
  if (line.length === 0) return null;
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}
