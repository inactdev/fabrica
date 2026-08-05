// The shapes the Foreman produces. Matched by hand to contract/surface.ts's
// Fabrica-facing types (GateResult, Receipt, Delivery, FabricaTask) so a
// real Fabrica satisfies both with no reshaping — declared locally rather
// than imported because src/ modules stay independent of contract/ (see
// AGENTS.md; src/record/types.ts sets the same precedent for FabricaEvent).

/** One check-command run inside a ProductionLine's workdir. */
export interface GateResult {
  green: boolean;
  output: string;
}

/** One attempt's structured receipt (CONTRACT rule 5). */
export interface Receipt {
  task: string;
  attempt: number;
  brain: string;
  model: string;
  startedAt: string;
  durationMs: number;
  /** Always null in v1: no adapter reports a real dollar figure yet, and
   * CONTRACT rule 10's enforcement is issue #11's job, not this module's. */
  costUsd: number | null;
  session: string | null;
  /** Always null in v1: `do()` never passes a reasoningEffort hint. */
  reasoningEffort: string | null;
  checks: GateResult | null;
  outcome: "delivered" | "failed" | "discarded-protected-path";
}

/** What reaches the Client (CONTRACT rule 4). All fields required — the
 * Foreman fills every one, even where later validation (issue #9) is what
 * actually enforces that none is missing. */
export interface Delivery {
  outcome: "done" | "failure-report" | "discarded-protected-path";
  confidence: number;
  summary: string;
  evidence: string;
  assumptions: string;
  gaps: string;
  branch: string;
  files: string[];
  gateChanges: string;
}

export interface FabricaTask {
  id: string;
  state: "asking" | "working" | "checking" | "delivered" | "failed" | "closed";
}
