// Issue #235: before a fix round starts, the task's branch is brought up
// to origin's current default branch, on the host, with git and nothing
// else - `src/line/rebase.ts` owns the git; this file owns the policy.
//
// The policy, in full (Client ruling, issue #235's clarifications):
//
//  1. Before EVERY fix round, not just the first - and skipped when the
//     branch already contains origin's tip.
//  2. Never in a worker. A worker's git mounts are read-only by design
//     (src/containment), so it could not commit a rebase anyway, and
//     rewriting history is not a judgement call to hand a model.
//  3. The first conflict a task hits is aborted back to the branch's own
//     last commit and delivered as `inspection-red` with the markers, so
//     the Client can rule `fix` with instructions. No worker runs at all
//     in that round.
//  4. The fix round he rules after seeing that report re-attempts the
//     rebase and, if it conflicts again, leaves it STOPPED: the worker
//     gets his note plus the conflicted file list and resolves the
//     markers in place, and the host stages everything and continues the
//     rebase itself once the worker returns. Markers still left behind
//     (or a later commit of the same rebase conflicting on its own) is
//     `inspection-red` again.
//  5. Nothing is ever pushed. Inspector owns the push after green;
//     Fabrica never pushes (src/foreman/README.md).
//
// How step 4 knows it is step 4: the delivery the Client just ruled on
// carries `rebaseConflict` (`queries.ts`'s `DeliveredDetails`). That is
// exactly "he has already seen a conflict report and this note answers
// it" - and it goes stale on its own, since the next ordinary delivery
// carries no such field, so a fresh conflict in a later round is reported
// to him first rather than silently handed to a worker with an unrelated
// note.

import { appendEvent, writeTaskFile } from "../record/index.ts";
import { rebaseOntoOriginDefault } from "../line/index.ts";
import type { RebaseConflict } from "../line/index.ts";
import type { ProductionLine } from "../../contract/surface.ts";
import type { Receipt } from "../inspector/types.ts";
import { buildRebaseConflictDelivery, renderDeliveryMarkdown } from "./delivery.ts";
import { diffFiles, validateDelivery } from "../delivery/index.ts";
import { costLabelOf } from "./caps.ts";

/** What the host-side rebase left a fix round to work with. */
export type FixRebase =
  /** The branch already contained origin's tip; nothing was rebased, and
   * the round keeps the base commit it already had. */
  | { status: "already-current" }
  /** The branch now sits on top of origin's tip, which is its fork point
   * from here on - a delivery's `files` diff must be pinned to it, or it
   * would list origin's own commits as this task's work. */
  | { status: "rebased"; base: string; baseCommit: string }
  /** Aborted back to the branch's own last commit: the Client has not
   * seen this conflict yet, so it is reported to him and no worker runs. */
  | { status: "report-conflict"; base: string; conflict: RebaseConflict }
  /** Left stopped in the worktree with the markers in place, for a worker
   * the Client has given instructions to. */
  | { status: "handed-to-worker"; base: string; baseCommit: string; conflict: RebaseConflict };

/**
 * Runs the rebase and records what it did. `sawConflictReport` is the
 * caller's read of the record - whether the delivery being fixed was
 * itself a conflict report - and is the only thing that decides whether a
 * conflict is aborted and reported or left stopped for the worker.
 */
export function rebaseForFixRound(
  recordHome: string,
  taskId: string,
  line: ProductionLine,
  opts: { sawConflictReport: boolean }
): FixRebase {
  const outcome = rebaseOntoOriginDefault(line, { onConflict: opts.sawConflictReport ? "stop" : "abort" });

  if (outcome.status === "already-current") return { status: "already-current" };
  if (outcome.status === "rebased") return { status: "rebased", base: outcome.base, baseCommit: outcome.baseCommit };

  const conflict = outcome.conflict!;
  appendEvent(recordHome, {
    taskId,
    name: "rebase-conflicted",
    details: { base: outcome.base, baseCommit: outcome.baseCommit, files: conflict.files, left: outcome.left },
  });

  return outcome.left === "stopped"
    ? { status: "handed-to-worker", base: outcome.base, baseCommit: outcome.baseCommit, conflict }
    : { status: "report-conflict", base: outcome.base, conflict };
}

/**
 * What the worker is told on top of the Client's own note when it is
 * handed a stopped rebase. Deliberately explicit that it must not reach
 * for git: its git mounts are read-only (src/containment), so a worker
 * that tried would get a confusing failure rather than a clear "that is
 * not your job".
 */
export function rebaseConflictInstructions(base: string, conflict: RebaseConflict): string {
  return [
    `Before this round, this task's branch was rebased onto \`origin/${base}\` and the rebase stopped on a ` +
      `conflict. It is still stopped in your working folder, with the conflict markers in place.`,
    "",
    "Resolve the conflict in each of these files, in place, leaving no `<<<<<<<`, `=======` or `>>>>>>>` " +
      "marker behind:",
    "",
    ...conflict.files.map((path) => `- ${path}`),
    "",
    "Do not run any git command: your git is read-only here. Once you are done, the host stages your " +
      "resolution and continues the rebase itself.",
  ].join("\n");
}

/**
 * Writes the one delivery a rebase conflict produces - `delivery.md` and
 * the `"delivered"` event - for both paths that reach it: a first
 * conflict, aborted before any worker ran, and a conflict a worker was
 * handed and did not resolve. One function so the two can never drift
 * into describing the same situation differently.
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
    receipts: Receipt[];
    totalAttempts: number | undefined;
    declaredGateChanges: string | undefined;
    afterWorker: boolean;
  }
): void {
  const delivery = buildRebaseConflictDelivery({
    branch: line.branch,
    files: diffFiles(line.project, line.branch, ctx.baseCommit),
    declaredGateChanges: ctx.declaredGateChanges,
    base: ctx.base,
    conflict: ctx.conflict,
    afterWorker: ctx.afterWorker,
  });
  validateDelivery(delivery);
  writeTaskFile(recordHome, taskId, "delivery.md", renderDeliveryMarkdown(delivery, costLabelOf(recordHome, taskId)));
  appendEvent(recordHome, {
    taskId,
    name: "delivered",
    details: {
      outcome: delivery.outcome,
      delivery,
      receipts: ctx.receipts,
      project: line.project,
      totalAttempts: ctx.totalAttempts,
      baseCommit: ctx.baseCommit,
      // The one field the next fix round branches on - see this file's
      // header, and `queries.ts`'s `DeliveredDetails`.
      rebaseConflict: { base: ctx.base, files: ctx.conflict.files },
    },
  });
}
