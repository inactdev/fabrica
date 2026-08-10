// Read-side access to a task's transcript.log (SPEC.md "The record") for
// `fabrica log --transcript` and `fabrica watch` (issue #12) - both live
// in src/cli and, per AGENTS.md's layering rule, reach the record only
// through src/index.ts, never src/record directly.

import { readTaskFile } from "../record/index.ts";
import type { TranscriptEntry } from "../brain/index.ts";

/** Every transcript entry written so far, oldest first. A line that fails
 * to parse (a torn read mid-append) is skipped rather than thrown - the
 * next read picks it up complete. */
export function readTranscript(recordHome: string, taskId: string): TranscriptEntry[] {
  const raw = readTaskFile(recordHome, taskId, "transcript.log");
  if (raw === null) return [];
  const entries: TranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    try {
      entries.push(JSON.parse(line) as TranscriptEntry);
    } catch {
      continue;
    }
  }
  return entries;
}
