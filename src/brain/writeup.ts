// The write-up every worker returns with its work (contract/surface.ts's
// WorkerWriteup). Shared by the adapters, which ask their brain for it in
// this exact shape, and the Foreman, which checks what came back.

import type { WorkerWriteup } from "./types.ts";

export const WRITEUP_TITLE_MAX_LENGTH = 60;

/** Every **required** field of a write-up, in the order the pull request
 * body renders them: why/what/how/outsideChanges verbatim under the
 * Client's own headings, then confidence/assumptions/expectedOutcomes/
 * deviations as labelled bullets under "Additional information"
 * (`src/foreman/pr-body.ts`). An adapter's JSON Schema uses this list as
 * its `required` array, so an *optional* field must never be added here -
 * see `WRITEUP_OPTIONAL_STRING_FIELDS`. */
export const WRITEUP_FIELDS = [
  "title",
  "why",
  "what",
  "how",
  "outsideChanges",
  "confidence",
  "assumptions",
  "expectedOutcomes",
  "deviations",
] as const satisfies readonly (keyof WorkerWriteup)[];

/** `WRITEUP_FIELDS` minus `confidence` - the required fields checked for
 * being a non-empty string. `confidence` is numeric and checked
 * separately. */
export const WRITEUP_STRING_FIELDS = [
  "title",
  "why",
  "what",
  "how",
  "outsideChanges",
  "assumptions",
  "expectedOutcomes",
  "deviations",
] as const satisfies readonly (keyof WorkerWriteup)[];

/** The write-up's optional string fields: offered to the worker, never
 * required of it, and omitted from the rendered body entirely when a
 * worker leaves one out (no placeholder - Client ruling 2026-10-18).
 * Kept out of `WRITEUP_FIELDS` because that list is what an adapter's
 * schema declares `required`; these are declared as properties only,
 * which both schemas need anyway since both set
 * `additionalProperties: false`. */
export const WRITEUP_OPTIONAL_STRING_FIELDS = [
  "couldNotVerify",
] as const satisfies readonly (keyof WorkerWriteup)[];
