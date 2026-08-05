// The shapes of Fabrica's record: the append-only event log plus the
// per-task folders it is the single source of truth for.
// SPEC.md "The record": events.jsonl is authoritative; everything else
// (request.md, answers.md, brief.md, plan.md, delivery.md, verdict,
// transcript.log) is a convenience view of it.

/**
 * Every event name Fabrica is known to emit. Standardised with
 * `contract/surface.ts`'s `FabricaEventName` so the two never drift into
 * two different closed sets for the same thing; declared locally here
 * (rather than imported) because src/ modules stay independent of
 * contract/ — see AGENTS.md.
 */
export type FabricaEventName =
  | "task-received"
  | "questions-asked"
  | "answers-given"
  | "work-started"
  | "check-run"
  | "delivered"
  | "verdict-recorded"
  | "cap-refused"
  | "cap-stopped"
  | "unattributed-change"
  | "edit-attempt-blocked"
  | "heartbeat"
  | "concurrent-write";

/** One line of events.jsonl (rule 5: "It writes everything down."). */
export interface FabricaEvent {
  occurredAt: string;
  taskId: string;
  name: FabricaEventName;
  details?: unknown;
}

/** Input to appendEvent: `occurredAt` is stamped by the record, never the caller. */
export type NewFabricaEvent = Omit<FabricaEvent, "occurredAt">;

/**
 * The seven files a task folder holds (SPEC.md "The record"). `request.md`
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
