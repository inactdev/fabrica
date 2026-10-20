// Is the network a worker box is running on still there? A per-call
// side channel, the same mechanism and the same reasoning as
// live-transcript.ts: keyed on `workdir`, the one value a caller
// (runAttempts, which chooses the workdir) and an adapter's
// `work(brief, workdir, opts)` already share through the ordinary Brain
// interface, and unique per task - so two tasks running concurrently in
// one process never cross wires, with nothing added to `Brain`'s
// ratified signature (CONTRACT rule 8's socket stays brief/workdir/
// opts).
//
// Why it exists (2026-10-18): a worker box reaches the network only
// through its task's own relay container (src/relay/). When that relay
// died, nothing noticed. The box went on running against an address
// with nothing listening, the Foreman went on recording heartbeats, and
// the first word of the problem was the worker's own "Unable to connect
// to API (ConnectionRefused)" four minutes later. The relay itself can
// no longer die that way (see src/relay/server.mjs), but "it cannot
// happen" is not a thing to leave a task's four minutes resting on: the
// Foreman's heartbeat now asks, every tick, whether the relay is still
// there, and an adapter that runs one answers.
//
// An adapter that opens no network of its own registers nothing, and
// `probeRelayHealth` then reports no problem - a Brain is complete
// without this.

/** Called on the Foreman's heartbeat interval while a `brain.work` call
 * for this workdir is in flight. Returns a sentence naming what is gone,
 * written to be shown to the Client, or `undefined` while the call's
 * network is healthy. May act as well as answer: the reference adapter
 * uses it to stop a worker box whose relay has died, so the `work()`
 * call ends at once instead of waiting for the box to notice by itself.
 * Must not throw - the caller is a timer. */
export type RelayHealthProbe = () => string | undefined;

const probes = new Map<string, RelayHealthProbe>();

/** Registers this workdir's probe for as long as its `work()` call runs.
 * Returns an unregister function - call it once that call settles, so a
 * later, unrelated call for the same workdir never reaches a stale
 * probe. */
export function registerRelayHealthProbe(workdir: string, probe: RelayHealthProbe): () => void {
  probes.set(workdir, probe);
  return () => {
    if (probes.get(workdir) === probe) probes.delete(workdir);
  };
}

/** Asks whatever is serving this workdir's network whether it still is.
 * `undefined` when all is well, when nothing registered a probe, or
 * when the probe itself failed (a probe that cannot answer is not
 * evidence of a dead relay - and must never be the reason a task is
 * failed). */
export function probeRelayHealth(workdir: string): string | undefined {
  const probe = probes.get(workdir);
  if (probe === undefined) return undefined;
  try {
    return probe();
  } catch {
    return undefined;
  }
}
