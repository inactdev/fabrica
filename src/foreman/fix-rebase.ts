// Issue #235: before a fix round starts, the task's branch is brought up
// to origin's current default branch, on the host, with git and nothing
// else - `src/line/rebase.ts` owns the git; this file owns the policy.
//
// The policy, in full (Client ruling, issue #235 and the ruling that made
// conflict handling one step):
//
//  1. Before EVERY fix round, not just the first - and skipped when the
//     branch already contains origin's tip.
//  2. Never in a worker. A worker's git mounts are read-only by design
//     (src/containment), so it could not commit a rebase anyway, and
//     rewriting history is not a judgement call to hand a model.
//  3. A conflict is handled in the SAME round, in one step: the rebase is
//     left STOPPED with the markers in the working tree, and this round's
//     worker gets the Client's own note plus the conflicted file list in
//     one brief. It resolves the markers in place; the host then stages
//     everything and continues the rebase itself.
//  4. Every later stop of the same rebase goes back to the same warm
//     worker, in the same round, until the rebase finishes - up to
//     `MAX_REBASE_STOPS_PER_ROUND` stops. Past that ceiling, and whenever
//     a worker leaves a marker behind, the rebase is aborted back to the
//     branch's own last commit and the surviving markers are delivered as
//     `inspection-red` for the Client to rule on.
//  5. A round that dies while the rebase is stopped (an unreachable
//     brain, a worker that throws) aborts it too - see verdict.ts's
//     `finally`. A stopped rebase never outlives the round that started
//     it, and is never left behind for the next round to find.
//  6. Nothing is ever pushed. Inspector owns the push after green;
//     Fabrica never pushes (src/foreman/README.md). What Fabrica does owe
//     Inspector is the one fact only this side knows once a rebase has
//     rewritten the branch: which commit origin's copy of it is expected
//     to still be at, so that forced publish is leased rather than blind
//     (`publishLeaseAfterRebase` below, inspector#53).
//
// There is deliberately no "report the conflict first and hand it to a
// worker only after he has ruled on it" step any more: that cost the
// Client a whole round to say nothing a worker could not already be told,
// and it made the round that followed depend on reading the previous
// delivery to know which shape it was. Nothing branches on that now.

import { appendEvent, writeTaskFile } from "../record/index.ts";
import { abortRebase, branchTip, finishRebase, rebaseOntoOriginDefault } from "../line/index.ts";
import type { BranchTips, RebaseConflict } from "../line/index.ts";
import type { ProductionLine } from "../../contract/surface.ts";
import type { Receipt } from "../inspector/types.ts";
import { buildRebaseConflictDelivery, renderDeliveryMarkdown, withRead, withTestMapReport } from "./delivery.ts";
import { reportForRound } from "./test-map.ts";
import type { TestMapEntry } from "../testmap/index.ts";
import type { DeliveryStamp } from "./fingerprint.ts";
import type { ReaderOnDelivery } from "../reader/index.ts";
import { diffFiles, validateDelivery } from "../delivery/index.ts";
import { costLabelOf } from "./caps.ts";

/** How many times one round's rebase may stop on a conflict and be handed
 * to its worker before the host gives up, aborts and reports (Client
 * ruling: "a ceiling of five stops before aborting and reporting"). A
 * rebase that keeps conflicting commit after commit is not something more
 * worker passes are going to fix, and the Client is the one who should see
 * that rather than a round that never ends. */
export const MAX_REBASE_STOPS_PER_ROUND = 5;

/** A rebase stopped mid-flight in the round's worktree, with the markers
 * in place, waiting for the worker it is about to be handed to. */
export interface StoppedRebase {
  /** origin's default branch name, e.g. "main" - never assumed. */
  base: string;
  /** The commit `origin/<base>` pointed at when the rebase started, and
   * so the branch's fork point once it finishes. */
  baseCommit: string;
  conflict: RebaseConflict;
  /** Which stop of this round's rebase this is, counting from 1. */
  stop: number;
}

/** What the host-side rebase left a fix round to work with. `tips` is
 * where the branch stood just before it ran, whichever way it went -
 * `publishLeaseAfterRebase` below is the only reader. */
export type FixRebase = { tips: BranchTips } & (
  /** The branch already contained origin's tip; nothing was rebased, and
   * the round keeps the base commit it already had. */
  | { status: "already-current" }
  /** The branch now sits on top of origin's tip, which is its fork point
   * from here on - a delivery's `files` diff must be pinned to it, or it
   * would list origin's own commits as this task's work. */
  | { status: "rebased"; base: string; baseCommit: string }
  /** Left stopped in the worktree with the markers in place, for this
   * round's own worker to resolve. */
  | { status: "handed-to-worker"; stopped: StoppedRebase }
);

/** Runs the rebase and records what it did. */
export function rebaseForFixRound(recordHome: string, taskId: string, line: ProductionLine): FixRebase {
  const outcome = rebaseOntoOriginDefault(line);
  const tips = outcome.tips;

  if (outcome.status === "already-current") return { status: "already-current", tips };
  if (outcome.status === "rebased") {
    return { status: "rebased", base: outcome.base, baseCommit: outcome.baseCommit, tips };
  }

  const stopped: StoppedRebase = {
    base: outcome.base,
    baseCommit: outcome.baseCommit,
    conflict: outcome.conflict!,
    stop: 1,
  };
  recordStop(recordHome, taskId, stopped, { left: "stopped" });
  return { status: "handed-to-worker", stopped, tips };
}

/**
 * What publishing a rebased branch has to lease against (inspector#53).
 *
 * A rebase rewrites the branch's commits, so publishing it is a forced
 * push - and a forced push with nothing to compare against would
 * overwrite whatever else had reached the published branch in the
 * meantime. `expectedTip` is the commit the publish may assume origin's
 * copy is still at: `origin/<branch>` as the fetch immediately before
 * the rebase left it, which is exactly what `--force-with-lease`
 * compares against (Client ruling). Anything else there means someone
 * else moved it, and the push must fail rather than win.
 */
export interface PublishLease {
  expectedTip: string;
  /** The branch's own last commit at that same moment, carried only when
   * it disagreed with `expectedTip` - a branch that moved locally since
   * it was last published. The remote one is still what is leased
   * against; this is here so the record says both (Client ruling). */
  localTip?: string;
}

/**
 * The lease this round's branch may be published under, asked once the
 * rebase has finished moving it - or undefined when nothing is leased:
 *
 *  - origin has no copy of this branch, or neither tip could be read: a
 *    branch nothing ever published has nothing to lease against, and
 *    this must never turn a publish that works today into a failure
 *    (Client ruling) - the flag is simply left off.
 *  - the rebase did not move the branch's tip: that is a fast-forward,
 *    which needs no lease (Client ruling). Measured around the rebase
 *    alone, before this round's worker commits anything on top, so a
 *    round that only ever worked is never mistaken for one that rebased.
 */
export function publishLeaseAfterRebase(line: ProductionLine, tips: BranchTips): PublishLease | undefined {
  if (tips.branch === null || tips.remote === null) return undefined;
  if (branchTip(line) === tips.branch) return undefined;
  return tips.branch === tips.remote
    ? { expectedTip: tips.remote }
    : { expectedTip: tips.remote, localTip: tips.branch };
}

/** Why the host stopped trying to finish this round's rebase. */
export type GiveUpReason =
  /** The worker had the Client's note and the conflicted file list, and
   * left at least one marker in the working tree. */
  | "markers-remain"
  /** The rebase kept stopping on fresh conflicts past
   * `MAX_REBASE_STOPS_PER_ROUND`. */
  | "too-many-stops";

/** Why the Client is being shown a conflict report - the two the host
 * gives up on above, plus the round ending underneath a rebase that was
 * still mid-flight (rule 10's spending cap stopping the loop). That last
 * one is not the rebase's own failure, and the report says so. */
export type ConflictReportReason = GiveUpReason | "round-ended";

/** What `continueStoppedRebase` did. */
export type FixRebaseStep =
  /** The rebase is finished: the branch sits on origin's tip, nothing is
   * in flight, and the round carries on as an ordinary one. */
  | { status: "completed" }
  /** A later commit of the same rebase conflicted afresh, and there is
   * still room under the ceiling: the rebase is left stopped again and
   * the same warm worker gets this conflict next, in this same round. */
  | { status: "handed-again"; stopped: StoppedRebase }
  /** Aborted back to the branch's own last commit - the tree is clean,
   * nothing was rewritten, and `conflict` is what the Client is shown.
   * `stops` is how many times this round's rebase stopped in all. */
  | { status: "give-up"; reason: GiveUpReason; conflict: RebaseConflict; stops: number };

/**
 * Called once the worker handed `stopped` has returned: stages its
 * resolution and continues the rebase (only the host can - a worker's git
 * is read-only), then decides which of the three above this is. Records
 * every stop and every abort as it goes.
 */
export function continueStoppedRebase(
  recordHome: string,
  taskId: string,
  line: ProductionLine,
  stopped: StoppedRebase
): FixRebaseStep {
  const finished = finishRebase(line.workdir);
  if (finished.status === "completed") return { status: "completed" };

  const nextStop = stopped.stop + 1;
  const next: StoppedRebase = { ...stopped, conflict: finished.conflict, stop: nextStop };

  // A marker left behind is never handed back in the same round: the
  // worker already had the Client's note and the file list, so the next
  // instruction it needs is his, not another copy of the same one.
  if (finished.reason === "markers-remain") {
    abortRebase(line.workdir);
    recordStop(recordHome, taskId, { ...stopped, conflict: finished.conflict }, {
      left: "aborted",
      reason: "markers-remain",
    });
    return { status: "give-up", reason: "markers-remain", conflict: finished.conflict, stops: stopped.stop };
  }

  if (nextStop > MAX_REBASE_STOPS_PER_ROUND) {
    abortRebase(line.workdir);
    recordStop(recordHome, taskId, next, { left: "aborted", reason: "too-many-stops" });
    return { status: "give-up", reason: "too-many-stops", conflict: finished.conflict, stops: nextStop };
  }

  recordStop(recordHome, taskId, next, { left: "stopped", reason: "new-conflict" });
  return { status: "handed-again", stopped: next };
}

/** The record's own account of what the host did with a conflict - purely
 * bookkeeping, read by no decision (src/inspector/types.ts's
 * `"rebase-conflicted"`). `left` says where the branch was left: still
 * mid-rebase for a worker, or back at its own last commit. */
export function recordStop(
  recordHome: string,
  taskId: string,
  stopped: StoppedRebase,
  how: { left: "stopped" | "aborted"; reason?: ConflictReportReason | "new-conflict" | "round-failed" }
): void {
  appendEvent(recordHome, {
    taskId,
    name: "rebase-conflicted",
    details: {
      base: stopped.base,
      baseCommit: stopped.baseCommit,
      files: stopped.conflict.files,
      stop: stopped.stop,
      left: how.left,
      ...(how.reason ? { reason: how.reason } : {}),
    },
  });
}

/**
 * What the worker is told on top of the Client's own note when it is
 * handed a stopped rebase. Deliberately explicit that it must not reach
 * for git: its git mounts are read-only (src/containment), so a worker
 * that tried would get a confusing failure rather than a clear "that is
 * not your job".
 */
export function rebaseConflictInstructions(stopped: StoppedRebase): string {
  const opening =
    stopped.stop === 1
      ? `Before this round, this task's branch was rebased onto \`origin/${stopped.base}\` and the rebase ` +
        `stopped on a conflict. It is still stopped in your working folder, with the conflict markers in place.`
      : `Your resolution was staged and the rebase moved on, then stopped again on a later commit of the same ` +
        `rebase (stop ${stopped.stop} of at most ${MAX_REBASE_STOPS_PER_ROUND} this round). It is still stopped ` +
        `in your working folder, with the new conflict markers in place.`;
  return [
    opening,
    "",
    "Resolve the conflict in each of these files, in place, leaving no `<<<<<<<`, `=======` or `>>>>>>>` " +
      "marker behind:",
    "",
    ...stopped.conflict.files.map((path) => `- ${path}`),
    "",
    "Do not run any git command: your git is read-only here. Once you are done, the host stages your " +
      "resolution and continues the rebase itself.",
  ].join("\n");
}

/**
 * Writes the one delivery an unresolved rebase conflict produces -
 * `delivery.md` and the `"delivered"` event.
 *
 * `baseCommit` is always the branch's ORIGINAL fork point here, never
 * origin's new tip: the rebase has been aborted by the time this runs, so
 * the branch is back where it was and that is what `files` must be
 * pinned to. The next fix round reads this same value back.
 */
export function deliverRebaseConflict(
  recordHome: string,
  taskId: string,
  line: ProductionLine,
  ctx: {
    base: string;
    conflict: RebaseConflict;
    baseCommit: string;
    /** THIS round's receipts only, with the task's cumulative count
     * beside them and the round's own gate declarations - the shape every
     * "delivered" event carries since issue #68. See
     * `queries.ts`'s `DeliveredDetails`. */
    receipts: Receipt[];
    attemptsSoFar: number;
    gateDeclarations: string[];
    totalAttempts: number | undefined;
    declaredGateChanges: string | undefined;
    reason: ConflictReportReason;
    stops: number;
    /** The project's committed test map, and the worker's own report of
     * which mapped tests it ran - carried here so a conflict report
     * names its unmapped touched files and broken mappings like every
     * other delivery. Nothing was handed to a check this round, which
     * the report's own wording already says by having no worker list to
     * show; omitting the block entirely would instead read as "this
     * project has no test map". */
    testMap?: TestMapEntry[] | null;
    workerTestsRun?: string;
    /** This pass's change fingerprint and how it compares with the
     * task's earlier passes (`fingerprint.ts`), taken by the caller
     * after the abort so it describes the branch as the Client will
     * find it. Passed in rather than taken here for the same reason
     * `files` is built from a base the caller pins: one place decides
     * what this round's branch state IS. */
    stamp: DeliveryStamp;
    /** The code reader's read of this task's diff, when this round
     * reached one before its rebase went wrong (inspector issue #34).
     * Carried onto the delivery like every other outcome's - a read that
     * happened is reported whatever the round then did. */
    reader?: ReaderOnDelivery;
  }
): void {
  const files = diffFiles(line.project, line.branch, ctx.baseCommit);
  const delivery = withRead(
    withTestMapReport(
      {
        ...buildRebaseConflictDelivery({
          branch: line.branch,
          files,
          declaredGateChanges: ctx.declaredGateChanges,
          base: ctx.base,
          conflict: ctx.conflict,
          reason: ctx.reason,
          stops: ctx.stops,
        }),
        ...ctx.stamp,
      },
      reportForRound(ctx.testMap, line.project, files, ctx.workerTestsRun)
    ),
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
      receipts: ctx.receipts,
      attemptsSoFar: ctx.attemptsSoFar,
      gateDeclarations: ctx.gateDeclarations,
      project: line.project,
      totalAttempts: ctx.totalAttempts,
      baseCommit: ctx.baseCommit,
      // Bookkeeping only: this marks the delivery as a conflict report
      // for anyone reading the record. Nothing branches on it - see
      // `queries.ts`'s `DeliveredDetails`.
      rebaseConflict: { base: ctx.base, files: ctx.conflict.files },
    },
  });
}
