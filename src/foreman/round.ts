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
  withRead,
  withTestMapReport,
} from "./delivery.ts";
import { mergeGateDeclarations } from "./gate-declarations.ts";
import { removeAttachedFiles } from "./task-files.ts";
import { reportForRound } from "./test-map.ts";
import type { TestMapEntry } from "../testmap/index.ts";
import { recordMeterPause } from "./meters.ts";
import { evaluateInShadow } from "../skiprules/index.ts";
import { deliverRebaseConflict } from "./fix-rebase.ts";
import { stampFor } from "./fingerprint.ts";
import { eventsOf, priorPassFingerprints } from "./queries.ts";
import { diffFiles, validateDelivery } from "../delivery/index.ts";
import { costLabelOf, recordCapStop, spendUnknownUnderCap } from "./caps.ts";
import type { Caps, ProductionLine } from "../../contract/surface.ts";
import type { Delivery, Receipt } from "../inspector/types.ts";
import type { ReaderOnDelivery } from "../reader/index.ts";

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
 * write both `delivery.md` and the `"delivered"` event - all of which is
 * `writeRoundResult` below - and then, once that delivery is on the
 * record, evaluate it against the project's skip rules in shadow mode
 * (issue #204), which decides nothing. Runs for every outcome uniformly
 * - see `src/foreman/README.md`'s "Rule 9: blocked by CI, not by
 * Fabrica's own mark" for why a declared or undeclared gate change is
 * never a special case here.
 */
export function recordRoundResult(
  recordHome: string,
  taskId: string,
  line: ProductionLine,
  ctx: RoundContext,
  attempts: AttemptLoopResult
): RoundRecordResult {
  const result = writeRoundResult(recordHome, taskId, line, ctx, attempts);

  // Issue #204, shadow mode only (Client ruling 2026-10-25): with a
  // delivery now on the record, ask this project's committed skip rules
  // what they WOULD have done with it, and write the answer down.
  // Nothing closes, nothing merges, and this task still waits on the
  // Client exactly as it did before - `evaluateInShadow` appends one
  // event and returns (and appends nothing at all for a project with no
  // rules file). Run here, in the one shared tail, so every delivery is
  // evaluated - including the meter pause, rebase conflict, unchanged
  // and commit-failure shapes `writeRoundResult` handles, every one of
  // which the code floor
  // in `src/skiprules/evaluate.ts` answers unsafe on sight.
  //
  // Only for a delivery: an Inspector refusal recorded nothing to
  // evaluate, and the conditions are questions about a delivery.
  if (result.kind === "recorded") {
    evaluateInShadow({
      recordHome,
      taskId,
      // The Client's own checkout, never `line.workdir` - the caller
      // destroys that worktree the moment this returns, and its copy of
      // the rules file is one this round's worker could have written.
      project: line.project,
      baseCommit: ctx.baseCommit,
      branch: line.branch,
    });
  }

  return result;
}

interface RoundContext {
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
  /** The project's committed test map, read by the caller before its
   * ProductionLine was cut (`test-map.ts`'s `testMapFor`). Null or
   * omitted for a project that commits none, and then no delivery
   * this round builds carries a `tests` field at all - an empty
   * report would read as "nothing was mapped" when the truth is
   * "nothing here maps anything". */
  testMap?: TestMapEntry[] | null;
  /** The code reader's read of this task's diff (inspector issue #34),
   * when this round is the one that reached it - built by
   * `reader-round.ts` before this is called. Put onto the delivery and
   * onto the `"delivered"` event, and read by nothing here: a flagger
   * never moves an outcome, so it is attached to a finished delivery
   * rather than passed to any builder as an input. */
  reader?: ReaderOnDelivery;
}

/**
 * The delivery half, exactly as it always was: interpret the last
 * judgement, commit whatever is left uncommitted, decide the outcome,
 * build and validate the `Delivery`, then write `delivery.md` and the
 * `"delivered"` event. Split out from `recordRoundResult` above only so
 * the shadow evaluation can run once, after whichever of the five
 * delivery shapes below actually landed.
 */
function writeRoundResult(
  recordHome: string,
  taskId: string,
  line: ProductionLine,
  ctx: RoundContext,
  attempts: AttemptLoopResult
): RoundRecordResult {
  // Issue #325, before anything below reads the branch or commits to
  // it: the files this task was handed go, so the fixed subfolder they
  // sat in during the round is not there for the delivery commit to see
  // at all. The Client's ruling is that they are "deleted before the
  // delivery commit", and this is the one place every round of every
  // shape passes through on its way to one - here rather than at do.ts's
  // and verdict.ts's two call sites, which would be two places for it to
  // go missing from one.
  //
  // Belt and braces with the exclusion src/attached/place.ts writes, not
  // instead of it: the folder is already invisible to `git add -A`, so
  // neither this nor that has to work alone for the files to stay out of
  // the branch. A no-op for every task handed no files, and for a
  // worktree holding a `.fabrica-files/` that is the project's own.
  removeAttachedFiles(line.workdir);

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

  // The change fingerprint every delivery below carries, and how it
  // stands against the task's earlier passes. `stamp()` reads the
  // branch, so each path calls it at the point ITS branch has finished
  // moving - after the commit on the ordinary path, after the abort on
  // the rebase-conflict path. The passes to compare against are read
  // once, here, before any of that: this round's own receipts are
  // already on the record by now (`onReceipt` appended them while the
  // attempts ran), and `priorPassFingerprints` drops the running pass
  // so a round is never compared with itself.
  const priorPasses = priorPassFingerprints(eventsOf(recordHome, taskId));
  const stamp = (): ReturnType<typeof stampFor> => stampFor(line.workdir, priorPasses);

  // Which attempt's receipt holds this round's check output in full
  // (issue #68): the last one that was actually judged. The delivery's
  // `evidence` names it and shows an excerpt instead of storing the same
  // text a second time - see delivery.ts's `checkEvidence`. Undefined
  // when nothing was judged, which the builders report as such.
  const evidenceAttempt = [...roundReceipts].reverse().find((receipt) => receipt.checks !== null)?.attempt;

  /**
   * This round's test-map report, resolved against the very `files` diff
   * the delivery itself reports, with the worker's own account of which
   * mapped tests it ran (`writeup.testsRun`) attached verbatim.
   *
   * Taking `files` off the built delivery rather than recomputing the
   * diff is the point: the report and the file list a reader sees beside
   * it can then never describe different sets of files, whichever
   * builder below produced it - including the commit-failure one, whose
   * `files` is deliberately `[]` and whose report therefore maps
   * nothing while still naming any mapping that points at a test file
   * the project no longer has.
   *
   * Nothing here compares the worker's list against the mapped one
   * (Client ruling: the record is the worker's own report and is marked
   * as such; Inspector's full-suite run is the independent check and is
   * not asked to verify the list).
   */
  const withTests = (delivery: Delivery): Delivery =>
    withTestMapReport(delivery, reportForRound(ctx.testMap, line.project, delivery.files, writeup?.testsRun));

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
    const delivery = withRead(
      withTests({
        ...buildPausedByMeterDelivery({
          attempts: allReceipts.length,
          branch: line.branch,
          files: diffFiles(line.project, line.branch, ctx.baseCommit),
          declaredGateChanges,
          pause: meterStop,
        }),
        ...stamp(),
      }),
      ctx.reader
    );
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
      testMap: ctx.testMap,
      ...(writeup?.testsRun === undefined ? {} : { workerTestsRun: writeup.testsRun }),
      // Taken after the abort, which has already put the branch back at
      // its own last commit - so this is the change the Client is being
      // asked to rule on, not the half-replayed state the rebase was in.
      stamp: stamp(),
      ...(ctx.reader === undefined ? {} : { reader: ctx.reader }),
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
    const delivery = withRead(
      withTests({
        ...buildNothingChangedDelivery({
          attempts: allReceipts.length,
          branch: line.branch,
          files: diffFiles(line.project, line.branch, ctx.baseCommit),
          declaredGateChanges,
        }),
        // Stamped like every other outcome, and expected to match: a
        // round whose worker left the branch where it was carries the
        // same change it already carried, which is exactly what the mark
        // should say rather than being left off.
        ...stamp(),
      }),
      ctx.reader
    );
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
    const delivery = withRead(
      withTests({
        ...buildCommitFailureDelivery({
          attempts: allReceipts.length,
          lastGate,
          evidenceAttempt,
          branch: line.branch,
          declaredGateChanges,
          error: commitError,
        }),
        // The commit failed, so the branch holds whatever it held before
        // this round - which is the honest thing to stamp: the delivery's
        // own `files` is `[]` for the same reason.
        ...stamp(),
      }),
      ctx.reader
    );
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
  const delivery = withRead(
    withTests({
      ...buildDelivery(outcome, {
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
      }),
      // Taken after the commit above, which is the last thing this round
      // does to the branch.
      ...stamp(),
    }),
    ctx.reader
  );

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
