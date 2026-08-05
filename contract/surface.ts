// contract/surface.ts — the shapes of fabrica's seams.
//
// Phase 0 declares these; Phase 1 must implement them. Every factory here
// throws NotBuiltError until the tool exists. That is what makes the
// contract tests red today — on purpose. When Phase 1 replaces these
// throws with a real implementation, the same tests become the judge.

export class NotBuiltError extends Error {
  constructor(phase = "Phase 1") {
    super(`fabrica is not built yet (${phase})`);
    this.name = "NotBuiltError";
  }
}

/** The brain socket (contract rule 8). The ONLY place a real AI plugs in. */
export interface Brain {
  name: string;
  model: string;
  work(
    instructions: string,
    workdir: string,
    opts?: {
      /** Warm sessions: pass a prior session id to continue that worker's context — a retry is a correction, never a cold restart. */
      session?: string;
      /** Free-form effort hint (e.g. "low", "high", or a tool's own vocabulary). An adapter that does not recognize the value must ignore it, not fail - and the value is recorded as requested regardless. */
      effort?: string;
    }
  ): Promise<{
    transcript: string;
    /** Open declaration of any ratified-test or check-setting changes made, and why (rule 9). Omitted = gate untouched. */
    gateChanges?: string;
    /** The session id for this run, so follow-ups and corrections can resume it. Lands on the receipt. */
    session?: string;
  }>;
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
  effort: string | null;
  gate: GateResult | null;
  outcome: "delivered" | "failed" | "discarded-protected-path";
}

/** What reaches the Client (rule 4). All fields required. */
export interface Delivery {
  kind: "done" | "failure-report" | "discarded-protected-path";
  confidence: number;
  did: string;
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

export interface FabricaEvent {
  occurredAt: string;
  taskId: string;
  name: string;
}

export interface Fabrica {
  do(
    taskText: string,
    opts: { project: string; n?: number; brain?: Brain }
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

/** Phase 1 replaces this throw with the real tool. */
export function createFabrica(_opts: {
  home: string;
  /** Rule 10: hard dollar limits, enforced by code. */
  caps?: { perTaskUsd?: number; perDayUsd?: number };
}): Fabrica {
  throw new NotBuiltError();
}

/** Phase 1 replaces this throw with the real delivery validator (rule 4). */
export function validateDelivery(_d: unknown): asserts _d is Delivery {
  throw new NotBuiltError();
}
