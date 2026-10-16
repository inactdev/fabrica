// The write-up every worker returns with its work (contract/surface.ts's
// WorkerWriteup). Shared by the adapters, which ask their brain for it in
// this exact shape, and the Foreman, which checks what came back.

import type { WorkerWriteup } from "./types.ts";

export const WRITEUP_TITLE_MAX_LENGTH = 60;

/** In the order a commit message and a pull request body render them -
 * Deviations last, since it is what the Client reads to see what to
 * double-check. */
export const WRITEUP_FIELDS = ["title", "what", "why", "how", "deviations"] as const satisfies readonly (keyof WorkerWriteup)[];

/** The write-up shape, as a JSON Schema - one schema object every adapter
 * that can ask its model for structured output hands over verbatim (the
 * reference CLI adapter's own JSON-schema flag, the direct-API adapters'
 * `submit_writeup` tool parameters), so "what a valid write-up looks
 * like" is written once rather than redeclared per adapter and risking
 * drift between them. */
export const WRITEUP_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [...WRITEUP_FIELDS],
  properties: {
    title: { type: "string", minLength: 1, maxLength: WRITEUP_TITLE_MAX_LENGTH },
    what: { type: "string", minLength: 1 },
    why: { type: "string", minLength: 1 },
    how: { type: "string", minLength: 1 },
    deviations: { type: "string", minLength: 1 },
  },
};
