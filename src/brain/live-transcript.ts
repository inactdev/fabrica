// A per-call side channel for an adapter that can report transcript
// entries as they're produced, not just once `work()` resolves (issue
// #70). Deliberately NOT part of BrainWorkOptions/contract/surface.ts:
// the Brain interface stays exactly as ratified, and an adapter with no
// finer-grained signal than "the whole call just finished" simply never
// calls emitLiveTranscriptEntry - runAttempts (src/foreman/attempts.ts)
// falls back to delivering such a brain's entries from the return value
// instead, so nothing here is required for a Brain to be correct.
//
// Keyed by `workdir`: the one value both a caller (runAttempts, which
// chooses the workdir) and an adapter's `work(brief, workdir, opts)` are
// already given through the ordinary Brain interface, and unique per
// task (each gets its own throwaway ProductionLine worktree) - so two
// tasks running concurrently in one process never cross wires, with no
// new parameter needed anywhere.

import type { TranscriptEntry } from "./types.ts";

type LiveTranscriptListener = (entry: TranscriptEntry) => void;

const listeners = new Map<string, LiveTranscriptListener>();

/** Registers the listener a `brain.work(..., workdir, ...)` call in
 * flight for `workdir` should report entries to as it produces them.
 * Returns an unregister function - call it once that call settles, so a
 * later, unrelated call for the same workdir never reaches a stale
 * listener. */
export function registerLiveTranscriptListener(workdir: string, listener: LiveTranscriptListener): () => void {
  listeners.set(workdir, listener);
  return () => {
    if (listeners.get(workdir) === listener) listeners.delete(workdir);
  };
}

/** An adapter's own notification that it just produced one transcript
 * entry for `workdir`. A no-op when nothing is listening (no caller
 * opted into live delivery, or this workdir's call already settled). */
export function emitLiveTranscriptEntry(workdir: string, entry: TranscriptEntry): void {
  listeners.get(workdir)?.(entry);
}
