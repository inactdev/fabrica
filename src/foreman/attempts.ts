// The counted retry loop (CONTRACT rule 3: "Three means three" — counting
// is a `for` loop in ordinary code, never a model deciding how many times
// to try). SPEC.md's default policy — one attempt, and on red one fix pass
// with the failure output, then re-check — is `stopEarlyOnGreen: true`.
// When the Client asks for a specific number of attempts, that number is
// run in full regardless of how early a check goes green: a number given
// is a number honored, not a ceiling the code is free to cut short.

import { registerLiveTranscriptListener } from "../brain/index.ts";
import type { Brain, BrainWorkResult, TranscriptEntry } from "../brain/index.ts";
import type { GateResult, Receipt } from "../../contract/surface.ts";
import type { Judge, Judgement } from "./judge.ts";
import { withStandingQuestion } from "./standing-question.ts";
import { costFromTranscript } from "./spend.ts";
import { describeMissingFinalMessage } from "./final-message.ts";
import { finalMessageFor } from "./pr-body.ts";
import type { FinalMessageForCommit } from "./pr-body.ts";

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
  /** The last red or green verdict; absent when no attempt reached one. */
  lastGate: GateResult | undefined;
  /** How the last attempt was judged - a verdict, or why there was none. */
  lastJudgement: Judgement;
  /** The most recent gateChanges declaration seen, if any attempt gave one. */
  declaredGateChanges: string | undefined;
  /** Set when rule 10 stopped the loop before it would otherwise have
   * ended - the last receipt's outcome is then "cap-stopped". */
  capStop?: CapStop;
  /** The last attempt's final message, resolved to something committable
   * either way (final-message.ts's parse, or a fallback naming what was
   * missing) - never the task's own words. What do.ts/verdict.ts commit
   * onto the branch once the loop ends. */
  finalMessage: FinalMessageForCommit;
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
  /** Judges each attempt once its work is done (judge.ts): Inspector, or
   * the worker's own box. Never a check run on the host. */
  judge: Judge;
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
  /** Fires once per transcript entry, as soon as it's known (issue
   * #70): live, the moment a streaming-capable brain reports it
   * through src/brain/live-transcript.ts, for every entry that arrived
   * that way; then, once brain.work() resolves, once more for any
   * trailing entries its return value carries that never arrived live
   * (a brain with no finer-grained signal than "the whole call just
   * finished" - e.g. a fake in a test - delivers every entry this way).
   * Either way, every entry reaches this exactly once, in order, and
   * the full set always matches workResult.transcript. */
  onTranscriptEntry?: (entry: TranscriptEntry) => void;
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
  /** A short label appended to the fallback commit title used when a
   * worker's final message doesn't parse (e.g. "(fix)" for verdict.ts's
   * fix round) - so even the fallback distinguishes an ordinary round
   * from a fix round, the way the old static commit messages did. */
  commitLabel?: string;
}): Promise<AttemptLoopResult> {
  const {
    brain,
    brief,
    workdir,
    taskId,
    judge,
    totalAttempts,
    stopEarlyOnGreen,
    initialSession,
    startAttempt,
    onTranscriptEntry,
    onHeartbeat,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    spendLimits,
    onReceipt,
    commitLabel,
  } = opts;

  const fallbackTitle = commitLabel ? `fabrica: ${taskId} ${commitLabel}` : `fabrica: ${taskId}`;

  const receipts: Receipt[] = [];
  let session: string | undefined = initialSession;
  let lastGate: GateResult | undefined;
  let lastJudgement: Judgement | undefined;
  let declaredGateChanges: string | undefined;
  let spentUsd = spendLimits?.priorKnownUsd ?? 0;
  let capStop: CapStop | undefined;
  let lastFinalMessage: FinalMessageForCommit | undefined;

  const firstAttempt = startAttempt ?? 1;
  const lastAttempt = firstAttempt + totalAttempts - 1;
  for (let attempt = firstAttempt; attempt <= lastAttempt; attempt++) {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();

    const thisBrief = withStandingQuestion(lastGate && !lastGate.green ? correctionBrief(brief, lastGate) : brief);
    // What is left of the task's own cap, as a hint an adapter that can
    // stop mid-call honors - the check after this attempt is the
    // guaranteed stop either way.
    const maxSpendUsd =
      spendLimits?.perTaskUsd !== undefined ? Math.max(0, spendLimits.perTaskUsd - spentUsd) : undefined;
    const workOpts = {
      ...(session ? { session } : {}),
      ...(maxSpendUsd !== undefined ? { maxSpendUsd } : {}),
    };
    // Issue #70: a brain that can report entries as it produces them
    // (today's reference adapter) does so through this listener, keyed
    // on `workdir` - the one value both sides already have through the
    // ordinary Brain interface, no new parameter needed (see
    // src/brain/live-transcript.ts). `liveEntries` is also kept so
    // that, once the call resolves, anything workResult.transcript
    // carries that never arrived this way (every entry, for a brain
    // that doesn't support live delivery at all) can still be
    // delivered - exactly once each, in order, never duplicated.
    const liveEntries: TranscriptEntry[] = [];
    const unregisterLiveTranscript = registerLiveTranscriptListener(workdir, (entry) => {
      liveEntries.push(entry);
      onTranscriptEntry?.(entry);
    });
    let workResult: BrainWorkResult;
    try {
      workResult = await withHeartbeat(onHeartbeat && (() => onHeartbeat(attempt)), heartbeatIntervalMs, () =>
        brain.work(thisBrief, workdir, Object.keys(workOpts).length > 0 ? workOpts : undefined)
      );
    } finally {
      unregisterLiveTranscript();
    }
    session = workResult.session ?? session;
    // liveEntries is always a prefix of workResult.transcript, in the
    // same order, by construction - a streaming adapter builds both
    // from the same stream in the same loop - so the remainder is
    // exactly what was never delivered live.
    for (const entry of workResult.transcript.slice(liveEntries.length)) onTranscriptEntry?.(entry);
    if (workResult.gateChanges) declaredGateChanges = workResult.gateChanges;

    const durationMs = Date.now() - t0;
    // Resolved once per attempt - the same {title, body} this attempt's
    // own commit and (in Inspector mode) its pull request would use. A
    // malformed final message is validated BEFORE judge() ever runs: judge
    // is what commits the attempt and (in Inspector mode) hands it off, so
    // a write-up that doesn't parse never reaches either - this attempt is
    // red on that alone, naming what's missing, which is also what the
    // next attempt's correction brief quotes back. Only a well-formed
    // write-up ever reaches judge(), so its own commit is only ever made
    // with a valid write-up as its message.
    const finalMessage = finalMessageFor(workResult.transcript, fallbackTitle);
    lastFinalMessage = finalMessage;
    const judgement: Judgement = finalMessage.ok
      ? await judge(attempt, workResult.gateChanges, finalMessage)
      : { kind: "verdict", gate: { green: false, output: describeMissingFinalMessage(finalMessage.missing!) } };
    const gate = judgement.kind === "verdict" ? judgement.gate : undefined;
    lastJudgement = judgement;
    if (gate) lastGate = gate;

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
      checks: gate ? gateForRecord(gate) : null,
      outcome: gate?.green ? "delivered" : "failed",
    };
    receipts.push(receipt);

    // Rule 10: an unknown cost under any cap, or the task's own spend at
    // its cap, stops the loop - unless the work already finished green on
    // its own terms, in which case nothing was cut short.
    const finishedGreen = gate !== undefined && gate.green && (stopEarlyOnGreen || attempt === lastAttempt);
    if (spendLimits && !finishedGreen) {
      if (spendLimits.capsActive && costUsd === null) {
        capStop = { reason: "spend-unknown", attempt, spentUsd };
      } else if (spendLimits.perTaskUsd !== undefined && spentUsd >= spendLimits.perTaskUsd) {
        capStop = { reason: "per-task-cap", attempt, spentUsd, capUsd: spendLimits.perTaskUsd };
      }
    }
    if (capStop) receipt.outcome = "cap-stopped";
    onReceipt?.(receipt);

    // No verdict (Inspector refused, the box could not run the check, the
    // commit failed) means nothing a further attempt could correct from.
    if (capStop || !gate || (gate.green && stopEarlyOnGreen)) break;
  }

  return {
    receipts,
    lastGate,
    lastJudgement: lastJudgement!,
    declaredGateChanges,
    finalMessage: lastFinalMessage!,
    ...(capStop ? { capStop } : {}),
  };
}

/** How much of a check's output anything stored in the record keeps — a
 * Receipt's `checks`, and (via delivery.ts) a Delivery's `evidence`. Both
 * land in the append-only record, are re-serialized onto every later
 * "delivered" event of the same task, and the whole events file is read
 * and parsed for every query — so a check's full output cannot be
 * stored whole. The live GateResult is left
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
  return withStandingQuestion(
    `${originalBrief}\n\n---\n\nYour previous attempt did not pass the project's check. ` +
      `Fix exactly this and nothing else:\n\n${failedGate.output}`
  );
}
