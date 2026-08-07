// contract/surface.ts — the shapes of fabrica's seams.
//
// Purely declarative (issue #45): this file describes and verifies, it
// never executes production code. Every type here is declared exactly
// once; src/** imports these as `import type` (erased at compile time, so
// that creates no runtime dependency on contract/) and implements them.
// contract/*.test.ts imports types from here and the implementation from
// src/index.ts — validateDelivery included (issue #9): the protection for
// CONTRACT rule 4 is the ratified test, not the function's location.

/**
 * A created, live ProductionLine: a linked git worktree of `project`
 * (CONTRACT rule 1, "it never touches your stuff" — `contract/
 * rule1.isolation.test.ts` exists solely to prove this shape holds).
 */
export interface ProductionLine {
  taskId: string;
  /** `fabrica/<taskId>` — left intact after the line is destroyed, for the Client to review. */
  branch: string;
  /** Resolved root of the Client's own checkout. Never written to. */
  project: string;
  /** The throwaway worktree — every Worker and check runs here. */
  workdir: string;
  /** Resolved record home the workdir was created under (`recordHome/tasks/<taskId>/worktree`). */
  recordHome: string;
}

/**
 * One piece of a worker's transcript. Structured rather than a single
 * string so a live view (Phase 4, #26) can render and expand entries
 * individually, instead of parsing one blob back apart. `kind` is
 * deliberately a free-form string, not a closed union — an adapter
 * reports whatever kind of chunk its own tool emits (e.g. "stdout",
 * "tool-call", "reasoning"), and a closed union would force every
 * adapter to speak one vocabulary.
 */
export interface TranscriptEntry {
  occurredAt: string;
  kind: string;
  text: string;
}

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

export interface BrainWorkResult {
  /** The live stream `fabrica watch` renders is derived from these
   * entries, in order. Adapters whose tool already emits structured
   * output map it directly; text-only adapters wrap each chunk as one
   * entry. */
  transcript: TranscriptEntry[];
  /** Open declaration of any ratified-test or check-setting changes made,
   * and why (rule 9). Omitted = gate untouched. */
  gateChanges?: string;
  /** The session id for this run, so follow-ups and corrections can
   * resume it. Lands on the receipt. */
  session?: string;
}

/** The brain socket (contract rule 8). The ONLY place a real AI plugs in. */
export interface Brain {
  name: string;
  model: string;
  work(brief: string, workdir: string, opts?: BrainWorkOptions): Promise<BrainWorkResult>;
}

export interface GateResult {
  green: boolean;
  output: string;
}

/** One attempt's structured receipt (rules 5). Cost is recorded from day one. */
export interface Receipt {
  task: string;
  attempt: number;
  brain: string;
  model: string;
  startedAt: string;
  durationMs: number;
  costUsd: number | null;
  session: string | null;
  reasoningEffort: string | null;
  checks: GateResult | null;
  outcome: "delivered" | "failed" | "discarded-protected-path";
}

/** What reaches the Client (rule 4). All fields required. */
export interface Delivery {
  outcome: "done" | "failure-report" | "discarded-protected-path";
  confidence: number;
  summary: string;
  evidence: string;
  assumptions: string;
  gaps: string;
  branch: string;
  files: string[];
  /** Declared gate changes (rule 9): which ratified tests or check settings changed, and why. Empty string when the gate was untouched. */
  gateChanges: string;
}

export interface FabricaTask {
  id: string;
  state: "asking" | "working" | "checking" | "delivered" | "failed" | "closed";
}

/**
 * Every event name Fabrica is known to emit. A closed union rather than a
 * free-form string so a typo is a build error, not a phantom event no
 * query will ever match. `contract/rule5.total-recall.test.ts` and
 * `contract/rule6.verdict-closes.test.ts` assert against these exact
 * strings; `concurrent-write` is the one synthetic name used only by the
 * record's own concurrency-proof test fixture.
 */
export type FabricaEventName =
  | "task-received"
  | "questions-asked"
  | "answers-given"
  | "work-started"
  | "check-run"
  | "delivered"
  | "verdict-recorded"
  | "cap-refused"
  | "cap-stopped"
  | "unattributed-change"
  | "edit-attempt-blocked"
  | "heartbeat"
  | "concurrent-write";

export interface FabricaEvent {
  occurredAt: string;
  taskId: string;
  name: FabricaEventName;
  /** Whatever extra context this event needs — a check's exit code, an attempt number, a verdict's note. Omitted, never null, when there is none. */
  details?: unknown;
}

export interface Foreman {
  do(
    taskText: string,
    opts: { project: string; attempts?: number; brain?: Brain }
  ): Promise<FabricaTask>;
  deliveryOf(taskId: string): Promise<Delivery | null>;
  receiptsOf(taskId: string): Promise<Receipt[]>;
  verdict(
    taskId: string,
    ruling: "accept" | "fix" | "wrong",
    note?: string
  ): Promise<void>;
  status(): Promise<FabricaTask[]>;
  events(taskId: string): Promise<FabricaEvent[]>;
  /** Absolute path of the append-only event record (events.jsonl). */
  recordPath(): string;
}
