// The counted retry loop (CONTRACT rule 3: "Three means three" — counting
// is a `for` loop in ordinary code, never a model deciding how many times
// to try). SPEC.md's default policy — one attempt, and on red one fix pass
// with the failure output, then re-check — is `stopEarlyOnGreen: true`.
// When the Client asks for a specific number of attempts, that number is
// run in full regardless of how early a check goes green: a number given
// is a number honored, not a ceiling the code is free to cut short.

import type { Brain, TranscriptEntry } from "../brain/index.ts";
import { runCheck } from "./check.ts";
import type { GateResult, Receipt } from "../../contract/surface.ts";

export interface AttemptLoopResult {
  /** One per attempt actually run, in order. Each entry's `outcome`
   * reflects its own check result; the caller overwrites the last entry
   * only if rule 9's gate-change check forces discarded-protected-path. */
  receipts: Receipt[];
  lastGate: GateResult;
  /** The most recent gateChanges declaration seen, if any attempt gave one. */
  declaredGateChanges: string | undefined;
}

export async function runAttempts(opts: {
  brain: Brain;
  brief: string;
  workdir: string;
  taskId: string;
  check: string;
  totalAttempts: number;
  stopEarlyOnGreen: boolean;
  onCheckRun?: (attempt: number, gate: GateResult) => void;
  onTranscript?: (transcript: TranscriptEntry[]) => void;
}): Promise<AttemptLoopResult> {
  const { brain, brief, workdir, taskId, check, totalAttempts, stopEarlyOnGreen, onCheckRun, onTranscript } = opts;

  const receipts: Receipt[] = [];
  let session: string | undefined;
  let lastGate: GateResult | undefined;
  let declaredGateChanges: string | undefined;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();

    const thisBrief = lastGate && !lastGate.green ? correctionBrief(brief, lastGate) : brief;
    const workResult = await brain.work(thisBrief, workdir, session ? { session } : undefined);
    session = workResult.session ?? session;
    if (workResult.transcript.length > 0) onTranscript?.(workResult.transcript);
    if (workResult.gateChanges) declaredGateChanges = workResult.gateChanges;

    const durationMs = Date.now() - t0;
    const gate = runCheck(workdir, check);
    onCheckRun?.(attempt, gate);
    lastGate = gate;

    receipts.push({
      task: taskId,
      attempt,
      brain: brain.name,
      model: brain.model,
      startedAt,
      durationMs,
      costUsd: null,
      session: session ?? null,
      reasoningEffort: null,
      checks: gate,
      outcome: gate.green ? "delivered" : "failed",
    });

    if (gate.green && stopEarlyOnGreen) break;
  }

  return { receipts, lastGate: lastGate!, declaredGateChanges };
}

/** Told exactly what failed (SPEC.md step 5), never a bare "try again." */
function correctionBrief(originalBrief: string, failedGate: GateResult): string {
  return (
    `${originalBrief}\n\n---\n\nYour previous attempt did not pass the project's check. ` +
    `Fix exactly this and nothing else:\n\n${failedGate.output}`
  );
}
