// The counted retry loop (CONTRACT rule 3: "Three means three" — counting
// is a `for` loop in ordinary code, never a model deciding how many times
// to try). SPEC.md's default policy — one attempt, and on red one fix pass
// with the failure output, then re-check — is `stopEarlyOnGreen: true`.
// When the Client asks for a specific number of attempts, that number is
// run in full regardless of how early a check goes green: a number given
// is a number honored, not a ceiling the code is free to cut short.

import { pauseWorker, probeRelayHealth, readMeters, registerLiveTranscriptListener } from "../brain/index.ts";
import type { Brain, BrainWorkResult, MeterReading, TranscriptEntry, WorkerWriteup } from "../brain/index.ts";
import type { GateResult } from "../../contract/surface.ts";
import type { Receipt } from "../inspector/types.ts";
import type { PauseRule } from "../config/index.ts";
import { meterReadingFromTranscript, pauseMessage, standingOf, stopFor } from "./meters.ts";
import type { MeterPausedDetails } from "./meters.ts";
import { modelFromTranscript, NO_MODEL_DECLARED, receiptModel } from "./model.ts";
import type { ModelChoice } from "./model.ts";
import type { Judge, Judgement } from "./judge.ts";
import { withStandingQuestion } from "./standing-question.ts";
import { costFromTranscript } from "./spend.ts";
import { describeInvalidWriteup, finalMessageFor, renderCommitMessage } from "./pr-body.ts";
import type { FinalMessageForCommit } from "./pr-body.ts";
import { commitWorktreeChanges } from "./commit.ts";
import { withTransportRetry } from "./transport-retry.ts";
import type { TransportRetryDetails } from "./transport-retry.ts";
import { ForemanError } from "./errors.ts";

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
   * only if the pre-teardown commit itself then fails. */
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
  /** Issue #189: set when the pause rule stopped an attempt mid-flight
   * - the last receipt's outcome is then "paused-by-meter", nothing was
   * judged, and the round delivers as "paused-by-meter". */
  meterStop?: MeterPausedDetails;
  /** The last attempt's write-up, resolved to something committable
   * either way (the worker's own, or a fallback naming what was wrong) -
   * never the task's own words. What do.ts/verdict.ts commit onto the
   * branch with, should anything be left uncommitted once the loop ends. */
  finalMessage: FinalMessageForCommit;
  /** The last attempt's own structured write-up (title/what/why/how/
   * deviations), set only when it was valid - absent when the last
   * attempt's write-up was missing or invalid, same as `finalMessage.ok`
   * being false. For a live view to show the worker's actual words
   * rather than `finalMessage`'s already-rendered commit body. */
  writeup?: WorkerWriteup;
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
 * all (an unknown cost only stops work under a cap); `priorMeteredUsd` is
 * what this task already spent in earlier rounds, metered spend only -
 * issue #188: a subscription estimate never counts toward `perTaskUsd`. */
export interface AttemptSpendLimits {
  capsActive: boolean;
  perTaskUsd?: number;
  priorMeteredUsd: number;
}

/** Issue #189's pause rule inside the loop: the thresholds, and the
 * clock to judge a reading's age against. Omitted, meters are still
 * recorded on every receipt (that is unconditional) but nothing ever
 * stops an attempt for them. */
export interface AttemptPauseRule {
  rule: PauseRule;
  /** Test seam - defaults to `Date.now`. A test drives a stale reading
   * past `METER_READING_MAX_AGE_MS` by moving this, not by waiting. */
  now?: () => number;
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
  /** Issue #199: fires once per `brain.work` call that failed the way a
   * dropped connection fails and is about to be retried, on the same
   * model. The caller records it as a "transport-retry" event. A retry
   * is NOT an attempt - it happens inside one turn of this loop and
   * never moves its counter (rule 3 counts attempts, not reconnects) -
   * so a long task can carry several of these against one attempt
   * number. Omitted, the retry still happens; only the record misses
   * it. */
  onTransportRetry?: (details: TransportRetryDetails) => void;
  /** Test-only override of DEFAULT_HEARTBEAT_INTERVAL_MS - a short value
   * lets a test observe a heartbeat without waiting 15 real seconds. */
  heartbeatIntervalMs?: number;
  /** Test-only override of DEPENDENCY_GONE_GRACE_MS - how long an
   * attempt waits for a `work()` call to end by itself after the
   * heartbeat has established that this box's network relay is gone. */
  relayGoneGraceMs?: number;
  /** Omitted, nothing about money stops the loop. */
  spendLimits?: AttemptSpendLimits;
  /** Which model this task asked for and where that came from (issue
   * #184), read off the task's own record by the caller
   * (`model.ts`'s `readModelChoice`) so a first round, a resumed round
   * and a fix round all report the same declaration. Recorded on every
   * receipt beside the model that actually ran; nothing in this loop
   * decides anything from it. Omitted means nothing declared one. */
  modelChoice?: ModelChoice;
  /** Issue #189. Omitted, nothing about the subscription meters stops
   * the loop - they are still read and recorded either way. */
  pauseRule?: AttemptPauseRule;
  /** Fires with each attempt's receipt the moment it exists, so its
   * spend is on the record even while the task is still running. */
  onReceipt?: (receipt: Receipt) => void;
  /** Issue #235: a host-side git step this attempt's own commit depends
   * on - finishing the rebase the worker was handed stopped, which only
   * the host can do (a worker's git is read-only). Runs once `work()`
   * returns and before anything is committed. Returning a judgement
   * means that step did not finish: the attempt is judged on it alone,
   * never committed, and never handed to a check or Inspector - the same
   * shape an invalid write-up already has. Omitted, nothing runs between
   * the two. */
  beforeCommit?: (attempt: number) => Promise<Judgement | undefined>;
  /** A short label appended to the fallback commit title used when a
   * worker's write-up is missing or invalid (e.g. "(fix)" for verdict.ts's
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
    onTransportRetry,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    relayGoneGraceMs,
    spendLimits,
    modelChoice = NO_MODEL_DECLARED,
    pauseRule,
    onReceipt,
    beforeCommit,
    commitLabel,
  } = opts;

  const fallbackTitle = commitLabel ? `fabrica: ${taskId} ${commitLabel}` : `fabrica: ${taskId}`;

  // Issue #199: which model a dropped call is reported against. There is
  // no transcript to read the model actually running off (the call never
  // came back), so the best this can honestly say is what the task asked
  // for, or failing that the brain's own label - and `receiptModel`'s
  // rule applies here too: a placeholder label names no model, and the
  // record says "unknown" rather than implying a choice nobody made.
  const modelForDroppedCall = receiptModel(modelChoice.declaredModel, brain.model);

  const receipts: Receipt[] = [];
  let session: string | undefined = initialSession;
  let lastGate: GateResult | undefined;
  let lastJudgement: Judgement | undefined;
  let declaredGateChanges: string | undefined;
  let spentUsd = spendLimits?.priorMeteredUsd ?? 0;
  let capStop: CapStop | undefined;
  let meterStop: MeterPausedDetails | undefined;
  let lastFinalMessage: FinalMessageForCommit | undefined;
  let lastWriteup: WorkerWriteup | undefined;
  // True while the branch's last commit is this loop's own, carrying a
  // fallback message: it was never handed to Inspector, so never pushed,
  // and the next attempt amends it rather than stacking on top of it.
  let unpublishedFallbackCommit = false;

  const firstAttempt = startAttempt ?? 1;
  const lastAttempt = firstAttempt + totalAttempts - 1;
  for (let attempt = firstAttempt; attempt <= lastAttempt; attempt++) {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();

    const thisBrief = withStandingQuestion(
      lastGate && !lastGate.green ? correctionBrief(brief, lastGate, lastJudgement) : brief
    );
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
    // Issue #189: the latest subscription-meter reading this attempt's
    // worker has reported, read on the heartbeat's own tick. Kept here
    // because the adapter's meter source only exists for as long as its
    // `work()` call does - by the time that call has settled there is
    // nothing left to ask, so the last tick's answer is what a paused
    // attempt's receipt has to be built from.
    let tickReading: MeterReading | undefined;
    // Runs on the heartbeat interval, from a timer: it must never throw
    // (withHeartbeat swallows it, but a silent swallow is not a reason
    // to be careless) and never block. Reading and deciding only - the
    // record is written by the caller, once, after the loop.
    const readAndJudgeMeters = (): void => {
      const reading = readMeters(workdir);
      if (reading !== undefined) tickReading = reading;
      if (pauseRule === undefined || meterStop !== undefined) return;
      const now = pauseRule.now?.() ?? Date.now();
      const over = stopFor(standingOf(reading ?? null, now), pauseRule.rule);
      if (over === undefined) return;
      // Decided first, acted on second: the decision is the fact, and a
      // worker that cannot be stopped must not make it look as though
      // nothing was decided. `pauseWorker` asks the adapter to stop its
      // own box gracefully (SIGTERM, then SIGKILL after a grace) - so
      // the `work()` call being awaited above ends by itself shortly
      // after this, and this loop then takes the paused path below.
      // `workerStopped: false` means that ask could not be carried out
      // - the adapter's own `pause()` threw - and the record says so
      // rather than claiming a stop that never happened. There is no
      // "nothing was registered" case to worry about here: a reading
      // only ever comes from a registered source, so a decision can
      // only be reached where there is something to ask.
      meterStop = {
        attempt,
        usedPercent: over.usedPercent,
        thresholdPercent: over.thresholdPercent,
        observedAt: over.observedAt,
        message: pauseMessage(over.usedPercent, over.thresholdPercent),
        workerStopped: pauseWorker(workdir),
      };
    };

    const tick =
      onHeartbeat === undefined && pauseRule === undefined
        ? undefined
        : () => {
            onHeartbeat?.(attempt);
            readAndJudgeMeters();
          };

    let workResult: BrainWorkResult | undefined;
    try {
      workResult = await withHeartbeat(
        tick,
        heartbeatIntervalMs,
        // Issue #199: a call dropped in transit is made once more, on
        // the same model, inside this one attempt. Wrapped by the
        // heartbeat rather than around it, deliberately: the heartbeat
        // keeps ticking through the wait and the second call, so a
        // retrying task never reads as quiet, and the relay-health
        // probe below still fails the whole thing if this box's network
        // is what died - that failure is raised outside this wrapper
        // and so is never itself retried.
        () =>
          withTransportRetry(
            () => brain.work(thisBrief, workdir, Object.keys(workOpts).length > 0 ? workOpts : undefined),
            {
              which: "work",
              model: modelForDroppedCall,
              // The pause rule already decided to stop this worker
              // (issue #189): the call ending is Fabrica's own doing a
              // moment earlier, not a dropped connection, and calling
              // the worker again is the last thing wanted here.
              giveUp: () => meterStop !== undefined,
              onRetry: (details) => {
                // The dropped call's live entries stay delivered - they
                // really were produced, and they are already in
                // transcript.log - but they are no longer a prefix of
                // anything: the retry returns its OWN transcript, and
                // the catch-up below slices by this array's length. Not
                // clearing it would silently drop the first entries of
                // the transcript that did come back.
                liveEntries.length = 0;
                onTransportRetry?.({ ...details, attempt });
              },
            }
          ),
        // Every tick also asks whether this box's own network is still
        // there (src/brain/relay-health.ts). A worker whose relay died
        // keeps running for minutes against an address with nothing
        // listening, reporting heartbeats the whole way, and then fails
        // with a bare "ConnectionRefused" of its own - observed
        // 2026-10-18. This fails the attempt on the next tick instead,
        // with what the relay watcher said.
        { probe: () => probeRelayHealth(workdir), ...(relayGoneGraceMs === undefined ? {} : { graceMs: relayGoneGraceMs }) }
      );
    } catch (err) {
      // Issue #189: a worker stopped by the pause rule normally ends by
      // reporting its own box going away, which is not a failure of
      // anything - the stop was Fabrica's own doing, decided a moment
      // earlier. Swallowed only in that case; every other error is the
      // attempt's real failure and still propagates.
      if (meterStop === undefined) throw err;
    } finally {
      unregisterLiveTranscript();
    }

    // The paused path: nothing is judged, nothing is handed to a check
    // or to Inspector, and whatever the worker had done by then is
    // committed with a fallback message so it survives the
    // ProductionLine's teardown for the fix round the Client can ask
    // for. The same shape an invalid write-up already has, for the same
    // reason: there is no write-up to commit with, because the worker
    // never got to the end of its own work.
    //
    // Named limit: a worker that resolves in the same instant the pause
    // trips - the tick decides, the SIGTERM is away, and `work()`
    // settles before it lands - is reported as paused all the same, and
    // its write-up is not used. That costs the Client one `fix` verdict
    // and nothing else: this attempt's changes are committed on the
    // branch either way, exactly as they would have been. Preferring
    // the resolved result instead would mean a second kind of paused
    // round, one that reports an ordinary outcome, through `round.ts`'s
    // single tail - more branching there than a window this narrow,
    // with no work lost in it, is worth.
    if (meterStop !== undefined) {
      const durationMs = Date.now() - t0;
      const transcript = workResult?.transcript ?? liveEntries;
      for (const entry of transcript.slice(liveEntries.length)) onTranscriptEntry?.(entry);
      session = workResult?.session ?? session;
      // Not `finalMessageFor(undefined, ...)`: that renders "write-up
      // invalid: the worker returned no write-up", which would be a lie
      // about why there is no write-up here. The worker was stopped; it
      // never reached the end of its own work. `ok: false` all the same
      // - this is Fabrica's own wording, not a worker's, so it is never
      // published or handed to Inspector.
      const finalMessage: FinalMessageForCommit = {
        title: `${fallbackTitle} (paused by the subscription meter)`,
        body: `${meterStop.message} Whatever the worker had done is kept in this commit, unreviewed.`,
        ok: false,
      };
      lastFinalMessage = finalMessage;
      lastWriteup = undefined;
      lastJudgement = { kind: "paused-by-meter" };
      try {
        commitWorktreeChanges(workdir, renderCommitMessage(finalMessage), { amend: unpublishedFallbackCommit });
      } catch (err) {
        // A commit that cannot happen must not turn a pause into an
        // exception: the pause is still the fact, and round.ts's report
        // names the branch either way. The host-failure path
        // (round.ts's own commit) will report it if it persists.
        if (!(err instanceof ForemanError) || err.code !== "commit-failed") throw err;
      }
      const { costUsd, costBasis } = costFromTranscript(transcript);
      if (costUsd !== null && costBasis === "metered") spentUsd += costUsd;
      const receipt: Receipt = {
        task: taskId,
        attempt,
        brain: brain.name,
        // Issue #184: the model the worker reported actually running,
        // out of its own transcript - never the brain's placeholder
        // label (see model.ts's receiptModel).
        model: receiptModel(modelFromTranscript(transcript), brain.model),
        declaredModel: modelChoice.declaredModel,
        modelSource: modelChoice.modelSource,
        startedAt,
        durationMs,
        costUsd,
        costUnknown: costUsd === null,
        costBasis,
        meters: meterReadingFromTranscript(transcript) ?? tickReading ?? null,
        session: session ?? null,
        reasoningEffort: null,
        checks: null,
        outcome: "paused-by-meter",
      };
      receipts.push(receipt);
      onReceipt?.(receipt);
      break;
    }

    // Settled, and not paused: the only way past the two branches above
    // is `brain.work()` having resolved.
    const work = workResult!;
    session = work.session ?? session;
    // liveEntries is always a prefix of work.transcript, in the
    // same order, by construction - a streaming adapter builds both
    // from the same stream in the same loop - so the remainder is
    // exactly what was never delivered live.
    for (const entry of work.transcript.slice(liveEntries.length)) onTranscriptEntry?.(entry);
    if (work.gateChanges) declaredGateChanges = work.gateChanges;

    const durationMs = Date.now() - t0;
    // Every attempt is committed the moment work() returns (Client ruling
    // 2026-10-13), with the worker's own write-up as the message, or a
    // fallback naming what is wrong with it. A fallback commit is never
    // handed to Inspector, so it is still unpublished when the next
    // attempt comes: that attempt amends it - new changes and message
    // together, or only the message when a retry supplies nothing but the
    // write-up - instead of an empty commit or re-handing the same one.
    // An attempt whose write-up is missing or invalid is red on that
    // alone, never judged, and its reason is what the next brief quotes.
    const finalMessage = finalMessageFor(work.writeup, fallbackTitle);
    lastFinalMessage = finalMessage;
    lastWriteup = finalMessage.ok ? work.writeup : undefined;
    // Issue #235: a host-side git step that has to happen between the
    // worker returning and this attempt being committed. When it reports
    // a failure, that IS this attempt's judgement - nothing is committed
    // on top of a branch the host could not get into the state the
    // commit assumes.
    const preempted = beforeCommit ? await beforeCommit(attempt) : undefined;
    let commitError: string | undefined;
    if (preempted === undefined) {
      try {
        const committed = commitWorktreeChanges(workdir, renderCommitMessage(finalMessage), {
          amend: unpublishedFallbackCommit,
        });
        if (committed) unpublishedFallbackCommit = !finalMessage.ok;
      } catch (err) {
        if (!(err instanceof ForemanError) || err.code !== "commit-failed") throw err;
        commitError = err.message;
      }
    }
    const judgement: Judgement =
      preempted !== undefined
        ? preempted
        : commitError !== undefined
        ? { kind: "commit-failed", error: commitError }
        : finalMessage.ok
          ? await judge(attempt, work.gateChanges, finalMessage)
          : {
              kind: "verdict",
              gate: { green: false, output: describeInvalidWriteup(finalMessage.reason!) },
              writeupInvalid: finalMessage.reason!,
            };
    const gate = judgement.kind === "verdict" ? judgement.gate : undefined;
    lastJudgement = judgement;
    if (gate) lastGate = gate;

    const { costUsd, costBasis } = costFromTranscript(work.transcript);
    // Issue #188: only metered spend counts toward the running total a
    // per-task cap checks against - a subscription estimate is recorded
    // on the receipt but never moves this number.
    if (costUsd !== null && costBasis === "metered") spentUsd += costUsd;
    const receipt: Receipt = {
      task: taskId,
      attempt,
      brain: brain.name,
      // Issue #184: what actually ran, from this attempt's own
      // transcript, with the declaration it was started under beside it.
      model: receiptModel(modelFromTranscript(work.transcript), brain.model),
      declaredModel: modelChoice.declaredModel,
      modelSource: modelChoice.modelSource,
      startedAt,
      durationMs,
      costUsd,
      costUnknown: costUsd === null,
      costBasis,
      // Issue #189: every receipt records both subscription meters. The
      // worker's own reading out of its transcript is the authoritative
      // one for this attempt; the last heartbeat tick's is the fallback
      // for a brain that reports readings live but nothing at the end,
      // and null means nobody could say - never 0%.
      meters: meterReadingFromTranscript(work.transcript) ?? tickReading ?? null,
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
    ...(meterStop ? { meterStop } : {}),
    ...(lastWriteup ? { writeup: lastWriteup } : {}),
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

/** How long `withHeartbeat` keeps waiting for `fn` after its probe has
 * reported that what the call depends on is gone. The reference adapter
 * stops its worker box the moment its own probe says so, which ends the
 * call in about a second; this is the ceiling for a brain that does not,
 * so "the relay died" can never again mean minutes of silence. */
export const DEPENDENCY_GONE_GRACE_MS = 30_000;

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
 * `fabrica status` reading "quiet"; a lost task costs the work.
 *
 * `opts.probe` runs on the same tick and asks whether what this call
 * depends on - the task's own network relay (src/brain/relay-health.ts)
 * - is still there. A sentence back means it is not: the heartbeat stops
 * (a call known to be doomed must not keep reporting "still going"), and
 * if `fn` has not settled within `opts.graceMs` this rejects with that
 * sentence rather than waiting for a worker to discover its own broken
 * network minutes later. */
export async function withHeartbeat<T>(
  tick: (() => void) | undefined,
  intervalMs: number,
  fn: () => Promise<T>,
  opts: { probe?: () => string | undefined; graceMs?: number } = {}
): Promise<T> {
  const { probe, graceMs = DEPENDENCY_GONE_GRACE_MS } = opts;
  if (!tick && !probe) return fn();

  let timer: NodeJS.Timeout | undefined;
  let graceTimer: NodeJS.Timeout | undefined;
  const stopTimers = () => {
    if (timer !== undefined) clearInterval(timer);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
  };

  const gone = new Promise<never>((_resolve, reject) => {
    timer = setInterval(() => {
      let problem: string | undefined;
      try {
        problem = probe?.();
      } catch {
        // A probe that cannot answer is not evidence of anything.
      }
      if (problem !== undefined) {
        // Stop ticking: the one honest thing left to report about this
        // call is the failure below, not another "still waiting".
        clearInterval(timer!);
        // Deliberately not `unref`'d: this timer is the only thing left
        // that will ever report why this attempt failed, so it is worth
        // holding the process open for - the alternative is an event
        // loop that empties and a task that just stops, with nothing on
        // the record saying why.
        graceTimer = setTimeout(() => reject(new ForemanError("worker-network-gone", problem!)), graceMs);
        return;
      }
      try {
        tick?.();
      } catch {
        // deliberately ignored - see above
      }
    }, intervalMs);
  });

  try {
    return await Promise.race([fn(), gone]);
  } finally {
    stopTimers();
  }
}

/** Told exactly what failed (SPEC.md step 5), never a bare "try again." */
function correctionBrief(originalBrief: string, failedGate: GateResult, last: Judgement | undefined): string {
  const what =
    last?.kind === "verdict" && last.writeupInvalid !== undefined
      ? "Your previous attempt's write-up was missing or invalid; your changes are kept."
      : "Your previous attempt did not pass the project's check.";
  return withStandingQuestion(
    `${originalBrief}\n\n---\n\n${what} Fix exactly this and nothing else:\n\n${failedGate.output}`
  );
}
