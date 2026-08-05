// Read-side of the loop: everything do() writes to events.jsonl, read
// back. events.jsonl is the single source of truth (SPEC.md "The
// record") — deliveryOf and receiptsOf don't parse delivery.md; they read
// the same "delivered" event do() wrote, which carries the structured
// Delivery and Receipt[] in its `details`.

import { readEvents, readEventsForTask } from "../record/index.ts";
import type { FabricaEvent } from "../record/index.ts";
import type { Delivery, FabricaTask, Receipt } from "./types.ts";

export function eventsOf(recordHome: string, taskId: string): FabricaEvent[] {
  return readEventsForTask(recordHome, taskId);
}

interface DeliveredDetails {
  outcome?: Delivery["outcome"];
  delivery?: Delivery;
  receipts?: Receipt[];
}

export function deliveryOf(recordHome: string, taskId: string): Delivery | null {
  const details = deliveredDetails(recordHome, taskId);
  return details?.delivery ?? null;
}

export function receiptsOf(recordHome: string, taskId: string): Receipt[] {
  const details = deliveredDetails(recordHome, taskId);
  return details?.receipts ?? [];
}

function deliveredDetails(recordHome: string, taskId: string): DeliveredDetails | undefined {
  const delivered = readEventsForTask(recordHome, taskId).find((e) => e.name === "delivered");
  return delivered?.details as DeliveredDetails | undefined;
}

export function statusOf(recordHome: string): FabricaTask[] {
  const byTask = new Map<string, FabricaEvent[]>();
  for (const event of readEvents(recordHome)) {
    const list = byTask.get(event.taskId);
    if (list) list.push(event);
    else byTask.set(event.taskId, [event]);
  }

  return Array.from(byTask, ([id, events]) => ({ id, state: deriveState(events) }));
}

function deriveState(events: FabricaEvent[]): FabricaTask["state"] {
  if (events.some((e) => e.name === "verdict-recorded")) return "closed";

  const delivered = events.find((e) => e.name === "delivered");
  if (delivered) {
    const details = delivered.details as { outcome?: Delivery["outcome"] } | undefined;
    return details?.outcome === "done" ? "delivered" : "failed";
  }

  if (events.some((e) => e.name === "check-run")) return "checking";
  if (events.some((e) => e.name === "work-started")) return "working";
  if (events.some((e) => e.name === "questions-asked")) return "asking";
  return "working";
}
