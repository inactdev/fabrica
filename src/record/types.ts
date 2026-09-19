// The shapes of Fabrica's record: the append-only event log plus the
// per-task folders it is the single source of truth for.
// SPEC.md "The record": events.jsonl is authoritative; everything else
// (request.md, answers.md, brief.md, plan.md, delivery.md, verdict,
// transcript.log) is a convenience view of it.

// The base record shapes are ratified in contract/surface.ts. Inspector's
// trigger and result events extend that closed set in src/inspector/types.ts.
import type { FabricaEvent, FabricaEventName } from "../inspector/types.ts";
export type { FabricaEvent, FabricaEventName };

/** Input to appendEvent: `occurredAt` is stamped by the record, never the caller. */
export type NewFabricaEvent = Omit<FabricaEvent, "occurredAt">;

/**
 * The files a task folder holds (SPEC.md "The record"). `request.md`
 * is the Client's words verbatim, written once and never appended to;
 * `answers.md` holds one section per clarification round; `brief.md` is
 * assembled from request plus every answer, and is the document a Worker
 * actually receives.
 */
export type TaskFile =
  | "request.md"
  | "answers.md"
  | "brief.md"
  | "plan.md"
  | "delivery.md"
  | "verdict"
  | "transcript.log";
