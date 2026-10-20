// The subscription meters a worker's own account is running against
// (issue #189): how much of the provider's 5-hour window and of its
// 7-day window has been used, as percentages.
//
// A per-call side channel, the same mechanism and the same reasoning as
// live-transcript.ts and relay-health.ts: keyed on `workdir`, the one
// value a caller (runAttempts, which chooses the workdir) and an
// adapter's `work(brief, workdir, opts)` already share through the
// ordinary Brain interface, and unique per task - so two tasks running
// concurrently in one process never cross wires, with nothing added to
// `Brain`'s ratified signature (CONTRACT rule 8's socket stays
// brief/workdir/opts).
//
// Why a side channel rather than a field on BrainWorkResult: the
// Foreman has to read these DURING a call, not after it. The 7-day
// meter passing its stop threshold has to stop the attempt that is
// running, and a return value arrives too late to stop anything.
//
// Nothing here knows which provider, which headers, or what scale the
// raw numbers came on - that is adapter-only knowledge (rule 8). An
// adapter that cannot report meters registers nothing, and every reader
// here then honestly answers "unknown", which the pause rule treats as
// "refuse nothing" (Client's clarification: fail open, never refuse on
// a number that could not be read).

/** One reading of both meters, as whole-percentage values of their own
 * window (so 64 means 64% of the week used). Either may be null: a
 * provider that reports one window and not the other is reported
 * exactly that way rather than having the missing one guessed at. */
export interface MeterReading {
  /** When the reading was taken, ISO-8601. What the staleness check
   * downstream measures against - a reading nobody has refreshed in
   * hours is not evidence about now. */
  observedAt: string;
  /** Percent of the provider's 5-hour window used, 0-100, or null when
   * it was not reported. */
  fiveHourPercent: number | null;
  /** Percent of the provider's 7-day window used, 0-100, or null when
   * it was not reported. */
  sevenDayPercent: number | null;
}

/** What an adapter offers for one in-flight `work()` call. */
export interface MeterSource {
  /** The latest reading the adapter has, or undefined when it has none
   * yet. Called from a timer (the Foreman's heartbeat): must not throw,
   * must not block, and must not itself go and ask anybody - it reports
   * whatever has already arrived. */
  reading: () => MeterReading | undefined;
  /** Stops this call's worker gracefully - the Foreman calls it when a
   * meter is past its stop threshold. Must be safe to call more than
   * once, and must not throw. */
  pause: () => void;
}

const sources = new Map<string, MeterSource>();

/** Registers this workdir's meter source for as long as its `work()`
 * call runs. Returns an unregister function - call it once that call
 * settles, so a later, unrelated call for the same workdir never
 * reaches a stale source (and so nothing can pause a worker that is no
 * longer running). */
export function registerMeterSource(workdir: string, source: MeterSource): () => void {
  sources.set(workdir, source);
  return () => {
    if (sources.get(workdir) === source) sources.delete(workdir);
  };
}

/** The latest meter reading for a `work()` call in flight on this
 * workdir. `undefined` when nothing registered a source, when no
 * reading has arrived yet, or when the source itself threw - an
 * unanswerable source is not evidence about a quota, and must never be
 * the reason work is refused. */
export function readMeters(workdir: string): MeterReading | undefined {
  const source = sources.get(workdir);
  if (source === undefined) return undefined;
  try {
    return source.reading();
  } catch {
    return undefined;
  }
}

/** Asks whatever is running on this workdir to stop gracefully. Returns
 * false when there was nothing registered to ask - the caller then
 * knows the attempt cannot be stopped this way and must say so rather
 * than report a stop that never happened. A throwing source is the same
 * answer: nothing was stopped. */
export function pauseWorker(workdir: string): boolean {
  const source = sources.get(workdir);
  if (source === undefined) return false;
  try {
    source.pause();
    return true;
  } catch {
    return false;
  }
}
