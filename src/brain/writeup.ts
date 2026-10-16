// The write-up every worker returns with its work (contract/surface.ts's
// WorkerWriteup). Shared by the adapters, which ask their brain for it in
// this exact shape, and the Foreman, which checks what came back.

import type { WorkerWriteup } from "./types.ts";

export const WRITEUP_TITLE_MAX_LENGTH = 60;

/** Every field of a write-up, in the order the pull request body renders
 * them: What/Why/How verbatim, then confidence/assumptions/
 * expectedOutcomes/deviations folded together into one final "What to
 * look at" section for the reviewer. */
export const WRITEUP_FIELDS = [
  "title",
  "what",
  "why",
  "how",
  "confidence",
  "assumptions",
  "expectedOutcomes",
  "deviations",
] as const satisfies readonly (keyof WorkerWriteup)[];

/** `WRITEUP_FIELDS` minus `confidence` - the fields checked for being a
 * non-empty string. `confidence` is numeric and checked separately. */
export const WRITEUP_STRING_FIELDS = [
  "title",
  "what",
  "why",
  "how",
  "assumptions",
  "expectedOutcomes",
  "deviations",
] as const satisfies readonly (keyof WorkerWriteup)[];
