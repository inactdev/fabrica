// Builds the Delivery block (SPEC.md "The delivery block") and its
// delivery.md rendering. This module only assembles the object — do.ts
// calls src/delivery's validateDelivery on the result before treating it
// as real (CONTRACT rule 4, issue #9).

import type { GateResult } from "../../contract/surface.ts";
import type { Delivery, Inspection } from "../inspector/types.ts";
import { gateForRecord } from "./attempts.ts";
import type { CapStop } from "./attempts.ts";
import { formatUsd, SPEND_UNKNOWN_LINE } from "./spend.ts";
import { SELF_TESTED } from "./judge.ts";

/** Where a task stands once this outcome is delivered: anything handed to
 * the Client for a ruling is "delivered"; the rest are honest failures. */
export function deliveredState(outcome: Delivery["outcome"] | undefined): "delivered" | "failed" {
  return outcome === "done" || outcome === "inspection-red" || outcome === "not-verified" ? "delivered" : "failed";
}

export function buildDelivery(
  outcome: Delivery["outcome"],
  ctx: {
    taskText: string;
    attempts: number;
    /** The last red or green verdict - absent when none was reached. */
    lastGate: GateResult | undefined;
    branch: string;
    files: string[];
    declaredGateChanges: string | undefined;
    inspection?: Inspection;
    /** No Inspector: the check ran in the worker's own box (issue #64). */
    selfTested?: boolean;
    /** Required for outcome "not-verified": why the box could not run it. */
    notVerifiedReason?: string;
    /** Required for outcome "cap-stopped": what stopped it. */
    capStop?: CapStop;
    taskId?: string;
    /** Rule 10: true when a cap is set and some attempt of this task has
     * an unknown cost - the report then says new work is blocked. */
    spendUnknownUnderCap?: boolean;
  }
): Delivery {
  if (outcome === "cap-stopped") return buildCapStoppedDelivery(ctx);
  if (outcome === "not-verified") return buildNotVerifiedDelivery(ctx);

  const summary =
    outcome === "done"
      ? `Completed: ${ctx.taskText}`
      : outcome === "failure-report"
        ? `The project's check did not pass after ${ctx.attempts} attempt(s).`
        : outcome === "inspection-red"
          ? `Inspector reported the committed branch red after ${ctx.attempts} attempt(s).`
          : "The project's checks changed without a declared gate change (rule 9) - blocked from " +
            "merging until the Client reviews it and chooses to override.";

  const checkOutput = ctx.lastGate ? gateForRecord(ctx.lastGate).output : "";

  const evidence =
    outcome === "discarded-protected-path"
      ? "check.sh no longer matches what the ProductionLine started with, and no gateChanges " +
        `declaration came with it. Last check: ${checkOutput}`
      : checkOutput;

  const gaps =
    outcome === "failure-report"
      ? "The project's check did not pass; see evidence for the failure output."
      : outcome === "inspection-red"
        ? "Inspector could not reach green after its mechanical repairs. The Client can give a fix verdict for work that needs the request's context."
        : outcome === "discarded-protected-path"
          ? `The work is not discarded - it is committed on \`${ctx.branch}\` like any other outcome. ` +
            "The merge is meant to be blocked by a repository CI gate reading the pull request's diff " +
            "for the touched protected path - today only Fabrica's own repository has one " +
            "(https://github.com/inactdev/fabrica/issues/55 tracks giving every managed project its " +
            "own). Only the Client can review the undeclared change and override that check to merge it."
          : "";

  // No Inspector: the builder checked the builder. Said plainly, and the
  // push is left to the Client rather than done for him.
  const selfTestNote =
    ctx.selfTested && outcome === "done"
      ? `${SELF_TESTED}. Pushing it is your choice: \`git push origin ${ctx.branch}\`.`
      : "";

  const spendNote = ctx.spendUnknownUnderCap
    ? `${SPEND_UNKNOWN_LINE}: this task's cost was never measured. Record it with ` +
      `\`fabrica cost ${ctx.taskId} <usd>\` before new work can start.`
    : "";

  return {
    outcome,
    confidence: outcome === "done" ? 100 : 0,
    summary,
    evidence,
    assumptions: "",
    gaps: [gaps, selfTestNote, spendNote].filter(Boolean).join("\n\n"),
    branch: ctx.branch,
    files: ctx.files,
    gateChanges: ctx.declaredGateChanges ?? "",
    ...(ctx.inspection === undefined ? {} : { inspection: ctx.inspection }),
  };
}

/** The self-tested path's honest report when the worker's box could not
 * run the check at all (a missing toolchain, no Docker): nothing judged
 * this work, which is said as exactly that - never dressed up as red. */
function buildNotVerifiedDelivery(ctx: {
  attempts: number;
  branch: string;
  files: string[];
  declaredGateChanges: string | undefined;
  notVerifiedReason?: string;
}): Delivery {
  const reason = ctx.notVerifiedReason ?? "unknown reason";
  return {
    outcome: "not-verified",
    confidence: 0,
    summary: `Not verified: the worker's box could not run the check - ${reason.split("\n")[0]}`,
    evidence: reason,
    assumptions: "",
    gaps:
      "Nothing checked this work: no Inspector is configured, and the worker's box could not run the " +
      `project's check. The work is committed on \`${ctx.branch}\` for you to check by hand, or give the ` +
      "box what the check needs and give a fix verdict.",
    branch: ctx.branch,
    files: ctx.files,
    gateChanges: ctx.declaredGateChanges ?? "",
  };
}

/** Rule 10's honest report for a task a cap stopped: it says the cap
 * stopped it, with the numbers, and is never worded as the work having
 * failed. The work so far is committed on the branch like any outcome. */
function buildCapStoppedDelivery(ctx: {
  attempts: number;
  lastGate: GateResult | undefined;
  branch: string;
  files: string[];
  declaredGateChanges: string | undefined;
  capStop?: CapStop;
  taskId?: string;
}): Delivery {
  const stop = ctx.capStop!;
  const lastCheck = ctx.lastGate
    ? `The last check (attempt ${stop.attempt}) was ${ctx.lastGate.green ? "green" : "red"}.`
    : "No check reached a verdict.";
  const summary =
    stop.reason === "spend-unknown"
      ? `${SPEND_UNKNOWN_LINE}. Stopped after attempt ${stop.attempt}: its cost was never measured, and a ` +
        "spending cap is set, so the task stopped rather than spend money nobody can count."
      : `Stopped by the per-task cap of ${formatUsd(stop.capUsd!)}: this task has spent ${formatUsd(stop.spentUsd)} ` +
        `over ${ctx.attempts} attempt(s), so no further attempt was started.`;
  const gaps =
    stop.reason === "spend-unknown"
      ? `A cap stopped this task, not its work. ${lastCheck} New work stays blocked until the real cost is ` +
        `recorded with \`fabrica cost ${ctx.taskId} <usd>\`. The work so far is committed on \`${ctx.branch}\`.`
      : `A cap stopped this task, not its work. ${lastCheck} The work so far is committed on \`${ctx.branch}\`. ` +
        "To continue, raise [caps].perTaskUsd in projects.toml, then give a fix verdict.";
  return {
    outcome: "cap-stopped",
    confidence: 0,
    summary,
    evidence: ctx.lastGate ? gateForRecord(ctx.lastGate).output : "",
    assumptions: "",
    gaps,
    branch: ctx.branch,
    files: ctx.files,
    gateChanges: ctx.declaredGateChanges ?? "",
  };
}

/**
 * A `Delivery` for the one path `buildDelivery` above doesn't cover: the
 * pre-teardown commit itself failed (a stale `.git/index.lock`, a full
 * disk, a read-only mount) and there is no branch content or check
 * outcome left to describe honestly the usual way. Reuses the
 * `failure-report` outcome rather than adding a new one to the contract
 * type - Client ruling (PR #54 follow-up), scoped minimally: the record
 * must always say what happened, not add retry machinery. `files` is
 * always `[]` here: a failed commit means nothing landed on the branch.
 */
export function buildCommitFailureDelivery(ctx: {
  attempts: number;
  lastGate: GateResult | undefined;
  branch: string;
  declaredGateChanges: string | undefined;
  error: string;
}): Delivery {
  return {
    outcome: "failure-report",
    confidence: 0,
    summary:
      `The Worker's changes could not be committed onto the branch ` +
      `after ${ctx.attempts} attempt(s).`,
    evidence: ctx.lastGate ? `Last check: ${gateForRecord(ctx.lastGate).output}` : "No check reached a verdict.",
    assumptions: "",
    gaps:
      `Committing the Worker's changes onto \`${ctx.branch}\` failed: ${ctx.error}. The throwaway ` +
      "workspace is destroyed regardless of outcome, so nothing survived to hand over - this is a " +
      "host environment failure (a stale lock file, a full disk, a read-only mount), not something " +
      "the Worker or the project's checks caused. Retrying the task from scratch is the only recovery.",
    branch: ctx.branch,
    files: [],
    gateChanges: ctx.declaredGateChanges ?? "",
  };
}

/** Human-readable rendering of a Delivery (SPEC.md's field order), for
 * `delivery.md` — a convenience view; the "delivered" event's `details`
 * carries the structured object deliveryOf() actually reads. */
export function renderDeliveryMarkdown(delivery: Delivery, cost?: string): string {
  return (
    [
      ...(cost === undefined ? [] : [`cost:       ${cost}`]),
      `confidence: ${delivery.confidence}`,
      `summary:    ${delivery.summary}`,
      `evidence:   ${delivery.evidence}`,
      `inspection: ${delivery.inspection ? `${delivery.inspection.verdict}: ${delivery.inspection.report}` : ""}`,
      `assumptions: ${delivery.assumptions}`,
      `gaps:       ${delivery.gaps}`,
      `branch:     ${delivery.branch}`,
      `files:      ${delivery.files.join(", ")}`,
      `gateChanges: ${delivery.gateChanges}`,
    ].join("\n") + "\n"
  );
}
