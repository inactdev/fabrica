// The shapes of Fabrica's record: the append-only event log plus the
// per-task folders it is the single source of truth for.
// SPEC.md "The record": events.jsonl is authoritative; everything else
// (request.md, answers.md, brief.md, plan.md, delivery.md, verdict,
// transcript.log) is a convenience view of it - except discarded.patch,
// whose content exists only in the task folder, never in the event log.

// FabricaEvent/FabricaEventName are declared once in contract/surface.ts
// (issue #45) and imported here as a type only - erased at compile time,
// so this creates no runtime dependency on contract/.
import type { FabricaEvent, FabricaEventName } from "../../contract/surface.ts";
export type { FabricaEvent, FabricaEventName };

/** Input to appendEvent: `occurredAt` is stamped by the record, never the caller. */
export type NewFabricaEvent = Omit<FabricaEvent, "occurredAt">;

/**
 * The files a task folder holds (SPEC.md "The record"). `request.md`
 * is the Client's words verbatim, written once and never appended to;
 * `answers.md` holds one section per clarification round; `brief.md` is
 * assembled from request plus every answer, and is the document a Worker
 * actually receives. `discarded.patch` exists only for a
 * discarded-protected-path outcome: it holds the diff rule 9 kept off the
 * branch, so a declaration mistake doesn't destroy the work behind it.
 */
export type TaskFile =
  | "request.md"
  | "answers.md"
  | "brief.md"
  | "plan.md"
  | "delivery.md"
  | "verdict"
  | "transcript.log"
  | "discarded.patch";
