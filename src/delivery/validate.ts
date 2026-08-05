// CONTRACT rule 4, "it never guesses silently": a Delivery missing any
// required field is malformed and must never be presented to the Client as
// done. The required-field checks below work on a bare `unknown` — no
// filesystem or git access — so they run the same way on a delivery that
// was only ever typed out by hand (as the contract test does) as on one
// the Foreman built.
//
// Checking the `files` field against the branch's real diff needs a live
// repo to check against, which a bare object never has — so that check
// only runs when a caller passes `project`, the second, optional
// argument. Omit it and this function is structure-only; pass it and it
// also proves the `files` claim (delegating to validate-files.ts's
// validateDeliveryFiles, so there is exactly one place that logic lives).

import type { Delivery } from "../../contract/surface.ts";
import { DeliveryError } from "./errors.ts";
import { validateDeliveryFiles } from "./validate-files.ts";

const OUTCOMES: ReadonlySet<Delivery["outcome"]> = new Set([
  "done",
  "failure-report",
  "discarded-protected-path",
]);

// The string-valued fields: required, but an empty string is a legitimate
// answer (e.g. `gaps: ""` when nothing was left undone), so only presence
// and type are checked here, not content.
const REQUIRED_STRING_FIELDS = ["summary", "evidence", "assumptions", "gaps", "branch", "gateChanges"] as const;

export function validateDelivery(value: unknown, project?: string): asserts value is Delivery {
  if (typeof value !== "object" || value === null) {
    throw new DeliveryError("malformed", "delivery is not an object");
  }
  const d = value as Record<string, unknown>;

  if (typeof d.outcome !== "string" || !OUTCOMES.has(d.outcome as Delivery["outcome"])) {
    throw new DeliveryError(
      "malformed",
      'delivery is missing required field "outcome" (must be "done", "failure-report", or "discarded-protected-path")'
    );
  }

  if (typeof d.confidence !== "number" || !Number.isFinite(d.confidence)) {
    throw new DeliveryError("malformed", 'delivery is missing required field "confidence"');
  }

  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof d[field] !== "string") {
      throw new DeliveryError("malformed", `delivery is missing required field "${field}"`);
    }
  }

  if (!Array.isArray(d.files) || d.files.some((file) => typeof file !== "string")) {
    throw new DeliveryError("malformed", 'delivery is missing required field "files"');
  }

  if (project !== undefined) {
    validateDeliveryFiles(value as Delivery, project);
  }
}
