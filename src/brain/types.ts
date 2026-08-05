// The brain socket (CONTRACT rule 8: "No favorite brain"). Matches the
// shape declared in contract/surface.ts so a real adapter satisfies both
// with no reshaping. This is the ONLY interface a Worker's model plugs
// into; nothing past this file may know which brain is behind it.

/** Warm-session support: pass a prior session id to continue that
 * worker's context. A retry is a correction into the same session,
 * never a cold restart that throws away what the worker just learned
 * (SPEC.md, adopted Aug 2026). */
export interface BrainWorkOptions {
  session?: string;
  /** Free-form effort hint (e.g. "low", "high", or a tool's own
   * vocabulary) - deliberately not a closed union, so callers never
   * couple to one adapter's vocabulary. An adapter that does not
   * recognize the value must ignore it, not fail; the value is still
   * recorded as requested regardless of whether the adapter used it. */
  reasoningEffort?: string;
}

/** One piece of a worker's transcript. Structured rather than a single
 * string so a live view (Phase 4, #26) can render and expand entries
 * individually. `kind` is deliberately free-form, not a closed union -
 * an adapter reports whatever kind of chunk its own tool emits (e.g.
 * "stdout", "tool-call", "reasoning"). */
export interface TranscriptEntry {
  occurredAt: string;
  kind: string;
  text: string;
}

export interface BrainWorkResult {
  /** The live stream `fabrica watch` renders is derived from these
   * entries, in order. Adapters whose tool already emits structured
   * output map it directly; text-only adapters wrap each chunk as one
   * entry. */
  transcript: TranscriptEntry[];
  /** Open declaration of any ratified-test or check-setting changes made,
   * and why (rule 9). Omitted = gate untouched. Carried through this seam
   * faithfully; validating it is issue #9's job. */
  gateChanges?: string;
  /** The session id for this run, so a retry can resume it. Lands on the
   * receipt. */
  session?: string;
}

/** One brain (a model, reached through a coding agent). Picking a
 * default is a setting; switching is a playbook tactic - never wiring. */
export interface Brain {
  name: string;
  model: string;
  work(brief: string, workdir: string, opts?: BrainWorkOptions): Promise<BrainWorkResult>;
}
