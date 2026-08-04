// The shapes of Fabrica's record: the append-only event log plus the
// per-task folders it is the single source of truth for.
// SPEC.md "The record": events.jsonl is authoritative; everything else
// (task.md, plan.md, delivery.md, verdict, transcript.log) is a
// convenience view of it.

/** One line of events.jsonl (rule 5: "It writes everything down."). */
export interface RecordEvent {
  ts: string;
  task: string;
  event: string;
  detail?: unknown;
}

/** Input to appendEvent: `ts` is stamped by the record, never the caller. */
export type NewRecordEvent = Omit<RecordEvent, "ts">;

/** The five files a task folder holds (SPEC.md "The record"). */
export type TaskFile = "task.md" | "plan.md" | "delivery.md" | "verdict" | "transcript.log";
