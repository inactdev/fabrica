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
 *
 * One kind is reserved (rule 10, issue #11): an entry with kind
 * "usage" carries, as its `text`, a JSON object
 * `{ "totalCostUsd": number | null, ... }` - what that one `work()` call
 * cost, in dollars, or null when the brain cannot say. Whatever assembles
 * a Receipt reads it: the attempt's `costUsd` is the sum of every usage
 * entry's `totalCostUsd`, and null if any of them is null, unparseable,
 * or there is no usage entry at all. Null never counts as zero.
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
  /** Rule 10's per-task cap, as a hint: the most this one call may spend,
   * in dollars - what is left of the task's own cap. Same pattern as
   * `reasoningEffort`: recorded as requested, and an adapter that cannot
   * honor it ignores it rather than failing. The Foreman's own check after
   * every attempt is the guaranteed stop; this only lets an adapter that
   * can stop mid-call do so. */
  maxSpendUsd?: number;
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

/**
 * A brain's judgment on whether a task needs clarification before any
 * ProductionLine exists (issue #8, SPEC.md step 2 "Clarify-or-proceed").
 */
export interface BrainAskResult {
  /** Numbered, Client-facing questions whose answers would change what
   * gets built - "materially ambiguous," not merely something a
   * reasonable person would fill in the same way every time. Empty or
   * omitted means the task is clear enough to proceed straight to work. */
  questions?: string[];
}

/** The brain socket (contract rule 8). The ONLY place a real AI plugs in. */
export interface Brain {
  name: string;
  model: string;
  work(brief: string, workdir: string, opts?: BrainWorkOptions): Promise<BrainWorkResult>;
  /** SPEC.md step 2: one pass over the bare task text, before any
   * ProductionLine is cut. Takes no `workdir` - by construction, this
   * call cannot touch any project, so CONTRACT rule 1 holds here without
   * relying on the brain's own good behavior. See BrainAskResult. */
  ask(brief: string): Promise<BrainAskResult>;
}

/**
 * Rule 10's hard dollar limits. Given once, to the Foreman when it is
 * created (`createForeman({ recordHome, caps })`) - never per call - so
 * every task the Foreman starts is held to the same numbers. Both
 * optional; an unset cap is no limit.
 *
 * - `perDayUsd`: a task (or a resumed round, or a fix) that would start
 *   while the spend recorded over the last 24 hours (a rolling window
 *   ending now, not a calendar day) is already at or past this is
 *   refused, with the numbers shown.
 * - `perTaskUsd`: a task whose own spend reaches this while it runs is
 *   stopped, with an honest report naming the cap.
 *
 * While either cap is set, a receipt whose cost is unknown blocks every
 * further start until its real cost is recorded by hand
 * (`Foreman.recordCost`): an unmeasured spend is never treated as zero.
 */
export interface Caps {
  perTaskUsd?: number;
  perDayUsd?: number;
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
  /** The mark rule 10 puts on an unmeasured receipt: true exactly when
   * `costUsd` is null, written on the record so the unknown is attached
   * to this specific spend rather than inferred later. */
  costUnknown: boolean;
  session: string | null;
  reasoningEffort: string | null;
  checks: GateResult | null;
  outcome: "delivered" | "failed" | "discarded-protected-path" | "cap-stopped";
}

/** What reaches the Client (rule 4). All fields required. */
export interface Delivery {
  /** "cap-stopped" (rule 10): a cap stopped the work, which is not the
   * same as the work having failed. */
  outcome: "done" | "failure-report" | "discarded-protected-path" | "cap-stopped";
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
  | "ask-failed"
  | "answers-given"
  | "line-cut"
  | "work-started"
  | "check-run"
  | "delivered"
  | "verdict-recorded"
  | "cap-refused"
  | "cap-stopped"
  | "receipt-recorded"
  | "cost-recorded"
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
  /** `fabrica answer <id> -m "<text>"` (issue #8): appends a clarification
   * round to a task stopped for questions, re-derives its brief, and
   * resumes it - the extended brief is what a Worker actually receives. */
  answer(taskId: string, text: string): Promise<FabricaTask>;
  deliveryOf(taskId: string): Promise<Delivery | null>;
  receiptsOf(taskId: string): Promise<Receipt[]>;
  verdict(
    taskId: string,
    ruling: "accept" | "fix" | "wrong",
    note?: string
  ): Promise<void>;
  status(): Promise<FabricaTask[]>;
  events(taskId: string): Promise<FabricaEvent[]>;
  /** `fabrica cost <taskId> <usd>` (rule 10): the owner records, by hand,
   * the real cost of every attempt of `taskId` whose cost is still
   * unknown, which clears the block those attempts put on new work.
   * Refuses when the task has nothing unmeasured to record. */
  recordCost(taskId: string, usd: number): Promise<void>;
  /** Absolute path of the append-only event record (events.jsonl). */
  recordPath(): string;
}
