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
  /** Verdict rule 6's "fix" path: resume the same warm worker session
   * instead of starting cold, so a correction keeps the worker's prior
   * context rather than re-discovering it. Omitted for an ordinary
   * do() call, which has no prior session to resume. */
  initialSession?: string;
  /** Verdict rule 6's "fix" path: the receipt `attempt` numbers continue
   * from where the task's prior rounds left off, instead of restarting
   * at 1, so the record shows one running count across the whole task. */
  startAttempt?: number;
  onCheckRun?: (attempt: number, gate: GateResult) => void;
  onTranscript?: (transcript: TranscriptEntry[]) => void;
}): Promise<AttemptLoopResult> {
  const {
    brain,
    brief,
    workdir,
    taskId,
    check,
    totalAttempts,
    stopEarlyOnGreen,
    initialSession,
    startAttempt,
    onCheckRun,
    onTranscript,
  } = opts;

  const receipts: Receipt[] = [];
  let session: string | undefined = initialSession;
  let lastGate: GateResult | undefined;
  let declaredGateChanges: string | undefined;

  const firstAttempt = startAttempt ?? 1;
  for (let attempt = firstAttempt; attempt < firstAttempt + totalAttempts; attempt++) {
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
      checks: gateForRecord(gate),
      outcome: gate.green ? "delivered" : "failed",
    });

    if (gate.green && stopEarlyOnGreen) break;
  }

  return { receipts, lastGate: lastGate!, declaredGateChanges };
}

/** How much of a check's output a Receipt keeps. A receipt is stored in
 * the append-only record, re-serialized onto every later "delivered"
 * event of the same task, and the whole events file is read and parsed
 * for every query — so a check free to print up to check.ts's 64MB
 * buffer cannot be stored whole. The live GateResult is left untouched:
 * the next attempt's correction brief and the Delivery's evidence both
 * still get the complete output. */
export const MAX_RECEIPT_CHECK_OUTPUT_BYTES = 16 * 1024;

/** Keeps the END of the output — a check announces what failed at the
 * end — behind a marker naming what was dropped, so the stored value is
 * never mistaken for the complete one. */
export function gateForRecord(gate: GateResult): GateResult {
  const total = Buffer.byteLength(gate.output, "utf8");
  if (total <= MAX_RECEIPT_CHECK_OUTPUT_BYTES) return gate;

  // Cutting at a byte offset can land mid-character; the decoder marks
  // the orphaned leading bytes with U+FFFD, which is dropped here rather
  // than stored as mojibake.
  const tail = Buffer.from(gate.output, "utf8")
    .subarray(total - MAX_RECEIPT_CHECK_OUTPUT_BYTES)
    .toString("utf8")
    .replace(/^�+/, "");
  const kept = Buffer.byteLength(tail, "utf8");

  return {
    green: gate.green,
    output: `[truncated, showing last ${kept} of ${total} bytes]\n${tail}`,
  };
}

/** Told exactly what failed (SPEC.md step 5), never a bare "try again." */
function correctionBrief(originalBrief: string, failedGate: GateResult): string {
  return (
    `${originalBrief}\n\n---\n\nYour previous attempt did not pass the project's check. ` +
    `Fix exactly this and nothing else:\n\n${failedGate.output}`
  );
}
