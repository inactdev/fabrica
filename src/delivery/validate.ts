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
// Client sees the real diff either way. CONTRACT rule 9's gateChanges is
// different: it is the Worker's own declared intent, never compared
// against anything on this side (Client ruling, issue #64 follow-up,
// 2026-10-08) — Fabrica runs no host-side watch over the gate at all now;
// a declared or undeclared change is only ever caught by the repository's
// own CI reading the pull request's diff.

import type { Delivery } from "../inspector/types.ts";
import { DeliveryError } from "./errors.ts";

const OUTCOMES: ReadonlySet<Delivery["outcome"]> = new Set([
  "done",
  "failure-report",
  "inspection-red",
  "cap-stopped",
  "not-verified",
  "nothing-changed",
  // Issue #189: a subscription meter past its stop threshold stopped
  // the round. Listed here like any other outcome - the whole point of
  // this validator is that nothing Fabrica built reaches the Client
  // unless its shape is one this side actually knows.
  "paused-by-meter",
]);

/** The permitted outcomes, worded once for both messages below: a
 * hand-written list beside this set would name the wrong permitted
 * values in the very error that rejects a value for not being one of
 * them - which is exactly what happened when "paused-by-meter" was
 * added to the set above. */
const OUTCOMES_PHRASE = `must be ${[...OUTCOMES]
  .map((outcome) => `"${outcome}"`)
  .reduce((phrase, name, index, all) => (index === all.length - 1 ? `${phrase}, or ${name}` : index === 0 ? name : `${phrase}, ${name}`), "")}`;
const INSPECTION_VERDICTS = new Set(["green", "red", "refused"]);

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
      `delivery is missing required field "outcome" (${OUTCOMES_PHRASE})`
    );
  }
  if (typeof d.outcome !== "string" || !OUTCOMES.has(d.outcome as Delivery["outcome"])) {
    throw new DeliveryError(
      "malformed",
      `delivery's "outcome" field is invalid (${OUTCOMES_PHRASE})`
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

  if (d.inspection !== undefined) {
    if (typeof d.inspection !== "object" || d.inspection === null) {
      throw new DeliveryError("malformed", `delivery's "inspection" field is not an object`);
    }
    const inspection = d.inspection as Record<string, unknown>;
    if (typeof inspection.verdict !== "string" || !INSPECTION_VERDICTS.has(inspection.verdict)) {
      throw new DeliveryError("malformed", `delivery's "inspection.verdict" field is invalid`);
    }
    if (typeof inspection.report !== "string") {
      throw new DeliveryError("malformed", `delivery's "inspection.report" field is not a string`);
    }
  }

  if (d.files === undefined) {
    throw new DeliveryError("malformed", 'delivery is missing required field "files"');
  }
  if (!Array.isArray(d.files) || d.files.some((file) => typeof file !== "string")) {
    throw new DeliveryError("malformed", `delivery's "files" field is not an array of strings`);
  }
}
