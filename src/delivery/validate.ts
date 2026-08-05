// CONTRACT rule 4, "it never guesses silently": a Delivery missing any
// required field is malformed and must never be presented to the Client as
// done. This checks structure and field types only — it takes `unknown`
// and has no filesystem or git access, so it works on a delivery that was
// only ever typed out by hand (as the contract test does) as well as one
// the Foreman built. Checking the `files` field against the branch's real
// diff is a separate concern (validate-files.ts) that needs a live repo to
// check against; this function never has one.

import type { Delivery } from "../../contract/surface.ts";
import { DeliveryError } from "./errors.ts";

const OUTCOMES: ReadonlySet<Delivery["outcome"]> = new Set([
  "done",
  "failure-report",
  "discarded-protected-path",
]);

// The string-valued fields: required, but an empty string is a legitimate
// answer (e.g. `gaps: ""` when nothing was left undone), so only presence
// and type are checked here, not content.
const REQUIRED_STRING_FIELDS = ["summary", "evidence", "assumptions", "gaps", "branch", "gateChanges"] as const;

export function validateDelivery(value: unknown): asserts value is Delivery {
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
}
