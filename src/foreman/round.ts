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
import { buildDelivery, buildCommitFailureDelivery, buildNothingChangedDelivery, renderDeliveryMarkdown } from "./delivery.ts";
import { diffFiles, validateDelivery } from "../delivery/index.ts";
import { costLabelOf, recordCapStop, spendUnknownUnderCap } from "./caps.ts";
import type { Caps, ProductionLine, Receipt } from "../../contract/surface.ts";
import type { Delivery } from "../inspector/types.ts";

/** Rule 9's declaration travels across rounds: a fix round that leaves an
 * earlier round's declared gate change alone must not lose that
 * declaration from the delivery. Both rounds' declarations are kept when
 * they differ; the delivery reports the whole cumulative diff, so it must
 * account for all of it. */
export function mergeGateDeclarations(prior: string | undefined, current: string | undefined): string | undefined {
  if (!prior) return current;
  if (!current || current === prior) return prior;
  return `${prior}\n\n${current}`;
}

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
    /** A fix round's earlier receipts/gate declaration, carried forward
     * so the delivery's attempt count and declared-gate-change wording
     * stay cumulative across the whole task. Omitted for a first-ever or
     * resumed-from-questions round, which has none. */
    priorReceipts?: Receipt[];
    priorGateChanges?: string;
  },
  attempts: AttemptLoopResult
): RoundRecordResult {
  const { receipts: newReceipts, lastGate, lastJudgement, declaredGateChanges: roundGateChanges, capStop, finalMessage, writeup } =
    attempts;

  // Inspector reached no verdict: recorded as such, never as red, and
  // nothing is delivered for a Client ruling.
  if (lastJudgement.kind === "refused") return { kind: "refused" };

  const declaredGateChanges = mergeGateDeclarations(ctx.priorGateChanges, roundGateChanges);
  const priorReceipts = ctx.priorReceipts ?? [];
  const allReceipts = [...priorReceipts, ...newReceipts];

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
        receipts: allReceipts,
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
        receipts: allReceipts,
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
    branch: line.branch,
    files: diffFiles(line.project, line.branch, ctx.baseCommit),
    declaredGateChanges,
    inspection: lastJudgement.kind === "verdict" ? lastJudgement.inspection : undefined,
    selfTested: ctx.mode.mode === "self-test",
    notVerifiedReason: lastJudgement.kind === "not-verified" ? lastJudgement.reason : undefined,
    writeupInvalid: lastJudgement.kind === "verdict" ? lastJudgement.writeupInvalid : undefined,
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
      receipts: allReceipts,
      project: line.project,
      totalAttempts: ctx.totalAttempts,
      baseCommit: ctx.baseCommit,
      ...(writeup ? { writeup } : {}),
    },
  });

  return { kind: "recorded", outcome: delivery.outcome };
}
