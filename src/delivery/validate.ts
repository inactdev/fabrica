// CONTRACT rule 4, "it never guesses silently": a Delivery missing any
// required field is malformed and must never be presented to the Client as
// done. Structural only — required fields, right types — on a bare
// `unknown`, so it runs the same way on a delivery that was only ever
// typed out by hand (as the contract test does) as on one the Foreman
// built.
//
// This used to also verify `files` against the branch's real diff
// (`validateDeliveryFiles`, since removed). Client ruling: `files` is
// already computed by do.ts straight from the real diff (`diffFiles`) —
// it is ground truth handed to the Client, never a Worker's separate
// claim laundered through a Delivery object. Comparing that value to the
// diff it was itself read from compares the diff to itself and cannot
// fail; even a misreporting Worker couldn't hide anything, since the
// Client sees the real diff either way. "Claims verified by code, never
// taken on faith" is sound and stays applied where a claim actually
// exists to distrust: CONTRACT rule 9 never trusts a Worker's word about
// whether the checks changed — it snapshots the gate before and after and
// compares (src/foreman/gate-changes.ts).

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

  if (d.outcome === undefined) {
    throw new DeliveryError(
      "malformed",
      'delivery is missing required field "outcome" (must be "done", "failure-report", or "discarded-protected-path")'
    );
  }
  if (typeof d.outcome !== "string" || !OUTCOMES.has(d.outcome as Delivery["outcome"])) {
    throw new DeliveryError(
      "malformed",
      `delivery's "outcome" field is invalid (must be "done", "failure-report", or "discarded-protected-path")`
    );
  }

  if (d.confidence === undefined) {
    throw new DeliveryError("malformed", 'delivery is missing required field "confidence"');
  }
  if (typeof d.confidence !== "number" || !Number.isFinite(d.confidence)) {
    throw new DeliveryError("malformed", `delivery's "confidence" field is not a finite number`);
  }

  for (const field of REQUIRED_STRING_FIELDS) {
    if (d[field] === undefined) {
      throw new DeliveryError("malformed", `delivery is missing required field "${field}"`);
    }
    if (typeof d[field] !== "string") {
      throw new DeliveryError("malformed", `delivery's "${field}" field is not a string`);
    }
  }

  if (d.files === undefined) {
    throw new DeliveryError("malformed", 'delivery is missing required field "files"');
  }
  if (!Array.isArray(d.files) || d.files.some((file) => typeof file !== "string")) {
    throw new DeliveryError("malformed", `delivery's "files" field is not an array of strings`);
  }
}
