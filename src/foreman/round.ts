// The one place "judge the work, commit it, decide the outcome, hand
// over the delivery, write the record" is written (issue #182). Every
// round a worker finishes - do.ts's first attempt or a retry/answered
// round, and verdict.ts's fix round - reaches this same tail with
// `runAttempts`' result once the attempt loop stops. What differs
// between callers (reopen versus create a ProductionLine, the attempt
// budget, a prior round's receipts/gate declarations to carry forward)
// is settled before this is called and arrives as `ctx`; this function
// itself does not know or care which caller it was.

import { appendEvent, writeTaskFile } from "../record/index.ts";
import { ForemanError } from "./errors.ts";
import { roundOutcome } from "./judge.ts";
import type { CheckMode } from "./judge.ts";
import { commitWorktreeChanges } from "./commit.ts";
import { renderCommitMessage } from "./pr-body.ts";
import type { AttemptLoopResult } from "./attempts.ts";
import {
  buildDelivery,
  buildCommitFailureDelivery,
  buildNothingChangedDelivery,
  buildPausedByMeterDelivery,
  renderDeliveryMarkdown,
} from "./delivery.ts";
import { mergeGateDeclarations } from "./gate-declarations.ts";
import { recordMeterPause } from "./meters.ts";
import { deliverRebaseConflict } from "./fix-rebase.ts";
import { diffFiles, validateDelivery } from "../delivery/index.ts";
import { costLabelOf, recordCapStop, spendUnknownUnderCap } from "./caps.ts";
import type { Caps, ProductionLine } from "../../contract/surface.ts";
import type { Delivery, Receipt } from "../inspector/types.ts";

export type RoundRecordResult =
  /** Inspector reached no verdict - nothing recorded here, since
   * inspection.ts already recorded the refusal itself. */
  | { kind: "refused" }
  | { kind: "recorded"; outcome: Delivery["outcome"] };

/**
 * Everything that happens once a round's `runAttempts` call has
 * resolved: interpret the last judgement, commit whatever is left
 * uncommitted, decide the delivery outcome (including a fix round's
 * "nothing changed" short-circuit), build and validate the `Delivery`,
 * and write both `delivery.md` and the `"delivered"` event. Runs for
 * every outcome uniformly - see `src/foreman/README.md`'s "Rule 9:
 * blocked by CI, not by Fabrica's own mark" for why a declared or
 * undeclared gate change is never a special case here.
 */
export function recordRoundResult(
  recordHome: string,
  taskId: string,
  line: ProductionLine,
  ctx: {
    baseCommit: string;
    taskText: string;
    totalAttempts: number | undefined;
    mode: CheckMode;
    caps?: Caps;
    /** Every receipt the task's EARLIER rounds produced, read back off
     * the record (`queries.ts`'s `receiptsOf`), so the delivery's attempt
     * count stays cumulative across the whole task. Omitted for a
     * first-ever or resumed-from-questions round, which has none. Not
     * stored on this round's event: issue #68 - each "delivered" event
     * carries its own round's receipts only, and the cumulative view is
     * reconstructed on read. */
    priorReceipts?: Receipt[];
    /** THIS round's own earlier worker passes' receipts, in order - a fix
     * round that hands its worker more than one stopped rebase (issue
     * #235) calls `runAttempts` once per pass, and every one of them is
     * this round's. They go on this round's event with the last pass's. */
    roundReceipts?: Receipt[];
    /** Every gate declaration the task's EARLIER rounds made, oldest
     * first (`queries.ts`'s `gateDeclarationsOf`) - see
     * `gate-declarations.ts` for how they are merged into the one the
     * delivery reports. */
    priorGateDeclarations?: string[];
    /** This round's own earlier worker passes' declarations, in order: a
     * fix round that hands its worker more than one stopped rebase
     * (issue #235) calls the worker more than once, and each pass's
     * declaration is this round's as much as the last pass's is. */
    roundGateDeclarations?: string[];
  },
  attempts: AttemptLoopResult
): RoundRecordResult {
  const {
    receipts: newReceipts,
    lastGate,
    lastJudgement,
    declaredGateChanges: roundGateChanges,
    capStop,
    meterStop,
    finalMessage,
    writeup,
  } = attempts;

  // Inspector reached no verdict: recorded as such, never as red, and
  // nothing is delivered for a Client ruling.
  if (lastJudgement.kind === "refused") return { kind: "refused" };

  // This round's own declarations - every pass of it, the last one
  // included - and the one text the delivery reports, newest declaration
  // per gate (issue #68, `gate-declarations.ts`).
  const roundGateDeclarations = [...(ctx.roundGateDeclarations ?? []), roundGateChanges].filter(
    (text): text is string => typeof text === "string" && text.trim().length > 0
  );
  const declaredGateChanges = mergeGateDeclarations([...(ctx.priorGateDeclarations ?? []), ...roundGateDeclarations]);
  const priorReceipts = ctx.priorReceipts ?? [];
  const roundReceipts = [...(ctx.roundReceipts ?? []), ...newReceipts];
  const allReceipts = [...priorReceipts, ...roundReceipts];

  // What every "delivered" event below carries about this round's
  // attempts (issue #68): THIS round's receipts, never the task's whole
  // history re-stored on each append - a task taken through many fix
  // rounds otherwise stores its early receipts once per later round, and
  // `src/record/read.ts` parses all of it for every query. The cumulative
  // view is reconstructed on read (`queries.ts`'s `receiptsOf`), and the
  // one cumulative fact a reader cannot reconstruct from one event alone
  // - how many attempts the task has had in all - rides along as a single
  // number instead of an array.
  const roundReceiptDetails = {
    receipts: roundReceipts,
    attemptsSoFar: allReceipts.length,
    gateDeclarations: roundGateDeclarations,
  };

  // Which attempt's receipt holds this round's check output in full
  // (issue #68): the last one that was actually judged. The delivery's
  // `evidence` names it and shows an excerpt instead of storing the same
  // text a second time - see delivery.ts's `checkEvidence`. Undefined
  // when nothing was judged, which the builders report as such.
  const evidenceAttempt = [...roundReceipts].reverse().find((receipt) => receipt.checks !== null)?.attempt;

  // Issue #189: the pause rule stopped an attempt mid-flight. Handled
  // before every branch below, for the same reason the rebase conflict
  // is: this is THE fact about the round, and nothing else here can
  // describe it - there is no judgement, no check output and no
  // write-up, because the attempt never got to the end of its own work.
  // `attempts.ts` already committed whatever the worker had done, so
  // the branch and the `files` diff below describe the same reality
  // every other outcome's do. A cap stop in the same round would be
  // double-reported, so it is deliberately not: the attempt that was
  // cut short is the one the pause explains.
  if (meterStop !== undefined) {
    const delivery = buildPausedByMeterDelivery({
      attempts: allReceipts.length,
      branch: line.branch,
      files: diffFiles(line.project, line.branch, ctx.baseCommit),
      declaredGateChanges,
      pause: meterStop,
    });
    validateDelivery(delivery);
    recordMeterPause(recordHome, taskId, meterStop);
    writeTaskFile(recordHome, taskId, "delivery.md", renderDeliveryMarkdown(delivery, costLabelOf(recordHome, taskId)));
    appendEvent(recordHome, {
      taskId,
      name: "delivered",
      details: {
        outcome: delivery.outcome,
        delivery,
        ...roundReceiptDetails,
        project: line.project,
        totalAttempts: ctx.totalAttempts,
        baseCommit: ctx.baseCommit,
      },
    });
    return { kind: "recorded", outcome: delivery.outcome };
  }

  // Issue #235: the worker was handed a stopped rebase and the host could
  // not finish it. The rebase is already aborted
  // (`fix-rebase.ts`'s `continueStoppedRebase`), so the branch is back at
  // its own last commit and
  // `ctx.baseCommit` is its original fork point again - which is why
  // nothing is committed here: whatever the worker left in the worktree
  // was either reset by the abort or is an untracked stray, and putting
  // it on the branch would contradict the delivery's own promise that
  // nothing was rewritten. Handled before the cap and "unchanged"
  // branches below, unlike those two, because a conflict is the fact
  // about the branch that the Client has to rule on either way: a
  // cap-stopped report would tell him to raise a cap when the real
  // blocker is a conflict. A cap stop in the same round still lands on
  // the record as its own event, so rule 10 loses nothing.
  if (lastJudgement.kind === "rebase-conflicted") {
    deliverRebaseConflict(recordHome, taskId, line, {
      base: lastJudgement.base,
      conflict: lastJudgement.conflict,
      baseCommit: ctx.baseCommit,
      ...roundReceiptDetails,
      totalAttempts: ctx.totalAttempts,
      declaredGateChanges,
      reason: lastJudgement.reason,
      stops: lastJudgement.stops,
    });
    if (capStop) recordCapStop(recordHome, taskId, capStop, "a rebase conflict stopped this round");
    return { kind: "recorded", outcome: "inspection-red" };
  }

  // A fix round whose Worker left the branch exactly where it already
  // was - never judged at all (`judge.ts`'s `skipIfUnchanged`) - unless
  // rule 10's cap already stopped this same round, which still wins.
  // Unreachable from a first-ever/resumed round: its judge is never
  // wrapped with `skipIfUnchanged`, so `lastJudgement.kind` is never
  // `"unchanged"` there.
  if (lastJudgement.kind === "unchanged" && !capStop) {
    const delivery = buildNothingChangedDelivery({
      attempts: allReceipts.length,
      branch: line.branch,
      files: diffFiles(line.project, line.branch, ctx.baseCommit),
      declaredGateChanges,
    });
    validateDelivery(delivery);
    writeTaskFile(recordHome, taskId, "delivery.md", renderDeliveryMarkdown(delivery, costLabelOf(recordHome, taskId)));
    appendEvent(recordHome, {
      taskId,
      name: "delivered",
      details: {
        outcome: delivery.outcome,
        delivery,
        ...roundReceiptDetails,
        project: line.project,
        totalAttempts: ctx.totalAttempts,
        baseCommit: ctx.baseCommit,
        ...(writeup ? { writeup } : {}),
      },
    });
    return { kind: "recorded", outcome: delivery.outcome };
  }

  const outcome: Delivery["outcome"] = roundOutcome({
    capStopped: capStop !== undefined,
    lastJudgement,
    mode: ctx.mode,
  });

  // A worker's edits live only as uncommitted changes in this throwaway
  // worktree, and the caller's teardown force-removes it once this
  // function returns. Committing here, before that, resolves PR #43's
  // flagged tension by construction: `files` is read back from the
  // branch's own diff (diffFiles) below, so it and `branch` describe the
  // same surviving reality. Runs for every outcome uniformly, declared or
  // undeclared gate change included - see the rule 9 comment in
  // README.md. Called unconditionally: commitWorktreeChanges already
  // asks the index directly and no-ops when there is nothing staged.
  let commitError = lastJudgement.kind === "commit-failed" ? lastJudgement.error : undefined;
  if (commitError === undefined) {
    try {
      commitWorktreeChanges(line.workdir, renderCommitMessage(finalMessage));
    } catch (err) {
      if (!(err instanceof ForemanError) || err.code !== "commit-failed") throw err;
      commitError = err.message;
    }
  }
  if (commitError !== undefined) {
    // A commit failure here (a stale lock, a full disk, a read-only
    // mount) must never vanish a task without a trace (Client ruling, PR
    // #54 follow-up) - caught and turned into a delivery of its own
    // instead, scoped minimally, no retry machinery.
    newReceipts[newReceipts.length - 1].outcome = "failed";
    const delivery = buildCommitFailureDelivery({
      attempts: allReceipts.length,
      lastGate,
      evidenceAttempt,
      branch: line.branch,
      declaredGateChanges,
      error: commitError,
    });
    validateDelivery(delivery);
    writeTaskFile(recordHome, taskId, "delivery.md", renderDeliveryMarkdown(delivery, costLabelOf(recordHome, taskId)));
    appendEvent(recordHome, {
      taskId,
      name: "delivered",
      details: {
        outcome: delivery.outcome,
        delivery,
        ...roundReceiptDetails,
        project: line.project,
        totalAttempts: ctx.totalAttempts,
        baseCommit: ctx.baseCommit,
      },
    });
    return { kind: "recorded", outcome: delivery.outcome };
  }

  // CONTRACT rule 9: an undeclared gate change is never force-reset,
  // thrown away, or specially marked on the branch - see
  // src/foreman/README.md's "Rule 9: blocked by CI, not by Fabrica's own
  // mark" for the full reasoning. Enforcement lives entirely outside
  // Fabrica, in `.github/workflows/rule9-gate.yml`.
  const delivery = buildDelivery(outcome, {
    taskText: ctx.taskText,
    attempts: allReceipts.length,
    lastGate,
    evidenceAttempt,
    branch: line.branch,
    files: diffFiles(line.project, line.branch, ctx.baseCommit),
    declaredGateChanges,
    inspection: lastJudgement.kind === "verdict" ? lastJudgement.inspection : undefined,
    selfTested: ctx.mode.mode === "self-test",
    notVerifiedReason: lastJudgement.kind === "not-verified" ? lastJudgement.reason : undefined,
    writeupInvalid: lastJudgement.kind === "verdict" ? lastJudgement.writeupInvalid : undefined,
    // Issue #267, read off the judgement exactly the way writeupInvalid
    // above is: the round is red, and this says whether it was the pull
    // request's own checks rather than Inspector that said so.
    ciRed: lastJudgement.kind === "verdict" ? lastJudgement.ciRed : undefined,
    capStop,
    taskId,
    spendUnknownUnderCap: spendUnknownUnderCap(recordHome, taskId, ctx.caps),
  });

  // Never present a malformed delivery as done (rule 4) — prove the
  // Foreman's own output before anyone else has to.
  validateDelivery(delivery);

  if (capStop) recordCapStop(recordHome, taskId, capStop, delivery.summary);
  writeTaskFile(recordHome, taskId, "delivery.md", renderDeliveryMarkdown(delivery, costLabelOf(recordHome, taskId)));
  appendEvent(recordHome, {
    taskId,
    name: "delivered",
    details: {
      outcome: delivery.outcome,
      delivery,
      ...roundReceiptDetails,
      project: line.project,
      totalAttempts: ctx.totalAttempts,
      baseCommit: ctx.baseCommit,
      ...(writeup ? { writeup } : {}),
    },
  });

  return { kind: "recorded", outcome: delivery.outcome };
}
