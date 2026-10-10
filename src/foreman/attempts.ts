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
import { costFromTranscript } from "./spend.ts";

/** How often a "heartbeat" event lands while a Worker's single `brain.work`
 * call is in flight (issue #12) - that call is one long, opaque await with
 * no incremental progress of its own to report, so this is the only signal
 * that separates "still going" from "silently stuck" until it resolves.
 * `fabrica status`/`watch` treat a gap much longer than this as "quiet too
 * long" rather than assuming progress. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

export interface AttemptLoopResult {
  /** One per attempt actually run, in order. Each entry's `outcome`
   * reflects its own check result; the caller overwrites the last entry
   * only if rule 9's gate-change check forces discarded-protected-path. */
  receipts: Receipt[];
  lastGate: GateResult;
  /** The most recent gateChanges declaration seen, if any attempt gave one. */
  declaredGateChanges: string | undefined;
  /** Set when rule 10 stopped the loop before it would otherwise have
   * ended - the last receipt's outcome is then "cap-stopped". */
  capStop?: CapStop;
}

/** Why rule 10 stopped a running task, and the numbers behind it. */
export interface CapStop {
  reason: "per-task-cap" | "spend-unknown";
  attempt: number;
  /** The task's known spend, every round included, when it stopped. */
  spentUsd: number;
  capUsd?: number;
}

/** Rule 10 inside the loop. `capsActive` is whether any cap is set at
 * all (an unknown cost only stops work under a cap); `priorKnownUsd` is
 * what this task already spent in earlier rounds. */
export interface AttemptSpendLimits {
  capsActive: boolean;
  perTaskUsd?: number;
  priorKnownUsd: number;
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
  /** Fires the instant a check starts running, before its (synchronous,
   * blocking) result is known - issue #12's "say what it's doing": with
   * this, status/watch can report "checking, Xm so far" using a real
   * recorded start time instead of guessing, and correctly stay silent
   * about "quiet too long" for a check that is simply still running. */
  onCheckStarted?: (attempt: number) => void;
  onCheckRun?: (attempt: number, gate: GateResult) => void;
  onTranscript?: (transcript: TranscriptEntry[]) => void;
  /** Fires roughly every `heartbeatIntervalMs` while a `brain.work` call
   * for `attempt` is still in flight. Omitted, no heartbeat runs. */
  onHeartbeat?: (attempt: number) => void;
  /** Test-only override of DEFAULT_HEARTBEAT_INTERVAL_MS - a short value
   * lets a test observe a heartbeat without waiting 15 real seconds. */
  heartbeatIntervalMs?: number;
  /** Omitted, nothing about money stops the loop. */
  spendLimits?: AttemptSpendLimits;
  /** Fires with each attempt's receipt the moment it exists, so its
   * spend is on the record even while the task is still running. */
  onReceipt?: (receipt: Receipt) => void;
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
    onCheckStarted,
    onCheckRun,
    onTranscript,
    onHeartbeat,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    spendLimits,
    onReceipt,
  } = opts;

  const receipts: Receipt[] = [];
  let session: string | undefined = initialSession;
  let lastGate: GateResult | undefined;
  let declaredGateChanges: string | undefined;
  let spentUsd = spendLimits?.priorKnownUsd ?? 0;
  let capStop: CapStop | undefined;

  const firstAttempt = startAttempt ?? 1;
  const lastAttempt = firstAttempt + totalAttempts - 1;
  for (let attempt = firstAttempt; attempt <= lastAttempt; attempt++) {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();

    const thisBrief = lastGate && !lastGate.green ? correctionBrief(brief, lastGate) : brief;
    // What is left of the task's own cap, as a hint an adapter that can
    // stop mid-call honors - the check after this attempt is the
    // guaranteed stop either way.
    const maxSpendUsd =
      spendLimits?.perTaskUsd !== undefined ? Math.max(0, spendLimits.perTaskUsd - spentUsd) : undefined;
    const workOpts = {
      ...(session ? { session } : {}),
      ...(maxSpendUsd !== undefined ? { maxSpendUsd } : {}),
    };
    const workResult = await withHeartbeat(onHeartbeat && (() => onHeartbeat(attempt)), heartbeatIntervalMs, () =>
      brain.work(thisBrief, workdir, Object.keys(workOpts).length > 0 ? workOpts : undefined)
    );
    session = workResult.session ?? session;
    if (workResult.transcript.length > 0) onTranscript?.(workResult.transcript);
    if (workResult.gateChanges) declaredGateChanges = workResult.gateChanges;

    const durationMs = Date.now() - t0;
    onCheckStarted?.(attempt);
    const gate = runCheck(workdir, check);
    onCheckRun?.(attempt, gate);
    lastGate = gate;

    const costUsd = costFromTranscript(workResult.transcript);
    if (costUsd !== null) spentUsd += costUsd;
    const receipt: Receipt = {
      task: taskId,
      attempt,
      brain: brain.name,
      model: brain.model,
      startedAt,
      durationMs,
      costUsd,
      costUnknown: costUsd === null,
      session: session ?? null,
      reasoningEffort: null,
      checks: gateForRecord(gate),
      outcome: gate.green ? "delivered" : "failed",
    };
    receipts.push(receipt);

    // Rule 10: an unknown cost under any cap, or the task's own spend at
    // its cap, stops the loop - unless the work already finished green on
    // its own terms, in which case nothing was cut short.
    const finishedGreen = gate.green && (stopEarlyOnGreen || attempt === lastAttempt);
    if (spendLimits && !finishedGreen) {
      if (spendLimits.capsActive && costUsd === null) {
        capStop = { reason: "spend-unknown", attempt, spentUsd };
      } else if (spendLimits.perTaskUsd !== undefined && spentUsd >= spendLimits.perTaskUsd) {
        capStop = { reason: "per-task-cap", attempt, spentUsd, capUsd: spendLimits.perTaskUsd };
      }
    }
    if (capStop) receipt.outcome = "cap-stopped";
    onReceipt?.(receipt);

    if (capStop || (gate.green && stopEarlyOnGreen)) break;
  }

  return { receipts, lastGate: lastGate!, declaredGateChanges, ...(capStop ? { capStop } : {}) };
}

/** How much of a check's output anything stored in the record keeps — a
 * Receipt's `checks`, and (via delivery.ts) a Delivery's `evidence`. Both
 * land in the append-only record, are re-serialized onto every later
 * "delivered" event of the same task, and the whole events file is read
 * and parsed for every query — so a check free to print up to check.ts's
 * 64MB buffer cannot be stored whole. The live GateResult is left
 * untouched: the next attempt's correction brief still gets the complete
 * output. */
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
    .replace(/^\uFFFD+/, "");
  const kept = Buffer.byteLength(tail, "utf8");

  return {
    green: gate.green,
    output: `[truncated, showing last ${kept} of ${total} bytes]\n${tail}`,
  };
}

/** Runs `fn`, calling `tick` on an interval for as long as it's pending.
 * The interval is cleared the instant `fn` settles, success or failure -
 * a heartbeat only ever means "still waiting," never "just finished."
 *
 * A throwing `tick` is swallowed on purpose. Every tick runs from a timer
 * callback, not from the awaited path, so a throw there is an uncaught
 * exception that kills the whole (detached) worker process mid-task -
 * skipping the caller's teardown, and leaving the record with no
 * "delivered"/"failed" event and the ProductionLine's worktree orphaned.
 * The real trigger is unexceptional: `appendEvent` throws on a short
 * write, ENOSPC, or EACCES. A missed heartbeat costs nothing more than a
 * `fabrica status` reading "quiet"; a lost task costs the work. */
export async function withHeartbeat<T>(
  tick: (() => void) | undefined,
  intervalMs: number,
  fn: () => Promise<T>
): Promise<T> {
  if (!tick) return fn();
  const timer = setInterval(() => {
    try {
      tick();
    } catch {
      // deliberately ignored - see above
    }
  }, intervalMs);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

/** Told exactly what failed (SPEC.md step 5), never a bare "try again." */
function correctionBrief(originalBrief: string, failedGate: GateResult): string {
  return (
    `${originalBrief}\n\n---\n\nYour previous attempt did not pass the project's check. ` +
    `Fix exactly this and nothing else:\n\n${failedGate.output}`
  );
}
