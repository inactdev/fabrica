// The write-up every worker returns with its work (contract/surface.ts's
// WorkerWriteup). Shared by the adapters, which ask their brain for it in
// this exact shape, and the Foreman, which checks what came back.

import type { WorkerWriteup } from "./types.ts";

export const WRITEUP_TITLE_MAX_LENGTH = 60;

/** In the order a commit message and a pull request body render them -
 * Deviations last, since it is what the Client reads to see what to
 * double-check. */
export const WRITEUP_FIELDS = ["title", "what", "why", "how", "deviations"] as const satisfies readonly (keyof WorkerWriteup)[];
