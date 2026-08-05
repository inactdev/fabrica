// Builds the Delivery block (SPEC.md "The delivery block") and its
// delivery.md rendering. This module only assembles the object — do.ts
// calls src/delivery's validateDelivery/validateDeliveryFiles on the
// result before treating it as real (CONTRACT rule 4, issue #9).

import type { Delivery, GateResult } from "../../contract/surface.ts";

export function buildDelivery(
  outcome: Delivery["outcome"],
  ctx: {
    taskText: string;
    attempts: number;
    lastGate: GateResult;
    branch: string;
    files: string[];
    declaredGateChanges: string | undefined;
  }
): Delivery {
  const summary =
    outcome === "done"
      ? `Completed: ${ctx.taskText}`
      : outcome === "failure-report"
        ? `The project's check did not pass after ${ctx.attempts} attempt(s).`
        : "Discarded: the worker changed the project's checks without declaring it.";

  const evidence =
    outcome === "discarded-protected-path"
      ? `check.sh changed without a declared gate change (rule 9). Last check: ${ctx.lastGate.output}`
      : ctx.lastGate.output;

  const gaps =
    outcome === "failure-report"
      ? "The project's check did not pass; see evidence for the failure output."
      : "";

  return {
    outcome,
    confidence: outcome === "done" ? 100 : 0,
    summary,
    evidence,
    assumptions: "",
    gaps,
    branch: ctx.branch,
    files: ctx.files,
    gateChanges: ctx.declaredGateChanges ?? "",
  };
}

/** Human-readable rendering of a Delivery (SPEC.md's field order), for
 * `delivery.md` — a convenience view; the "delivered" event's `details`
 * carries the structured object deliveryOf() actually reads. */
export function renderDeliveryMarkdown(delivery: Delivery): string {
  return (
    [
      `confidence: ${delivery.confidence}`,
      `summary:    ${delivery.summary}`,
      `evidence:   ${delivery.evidence}`,
      `assumptions: ${delivery.assumptions}`,
      `gaps:       ${delivery.gaps}`,
      `branch:     ${delivery.branch}`,
      `files:      ${delivery.files.join(", ")}`,
      `gateChanges: ${delivery.gateChanges}`,
    ].join("\n") + "\n"
  );
}
