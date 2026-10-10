// After spawnDetachedTask resolves with a taskId, the detached child is
// still running doTask() (src/foreman/do.ts): register -> ask -> maybe
// isolate/work, all inside that one call. This polls the task's own
// record for whichever outcome lands first - a spending cap's refusal
// (rule 10), questions, a failed clarifying step ("ask-failed"), any
// other failure before work starts ("task-failed", #73), or
// "work-started" - so `fabrica do` can print numbered questions and stop
// (SPEC.md step 2), or report a real failure, instead of only ever
// printing the task id.
//
// There is no fixed cutoff (Client ruling 2026-10-10): a slow clarifying
// step is waited out, with a "still waiting" line every 15s, rather than
// reported as "proceeding" - which is how a task that never started used
// to look like one that did. The one other way out is the task's own
// process ending with nothing recorded, which is a failure, not a wait.

import { createForeman } from "../index.ts";
import type { FabricaEvent } from "../index.ts";

export interface AskOutcome {
  status: "asking" | "proceeding" | "failed" | "cap-refused";
  /** Populated only when status is "asking". */
  questions: string[];
  /** Populated only when status is "failed" - brain.ask()'s own error
   * message, verbatim (src/foreman/ask.ts's "ask-failed" event) - or
   * "cap-refused" - the refusal's own message, numbers and unmeasured
   * task ids included (src/foreman/caps.ts). */
  reason?: string;
}

/** How often `fabrica do` says it is still waiting (#73): long enough not
 * to flood the terminal, short enough that silence never reads as done. */
export const STILL_WAITING_INTERVAL_MS = 15_000;
export const STILL_WAITING_LINE = "still waiting on the clarifying step";

export async function waitForAskOutcome(
  recordHome: string,
  taskId: string,
  opts: {
    pollMs?: number;
    noticeMs?: number;
    onStillWaiting?: (line: string) => void;
    /** Whether the task's own process is still running. Once it is not,
     * whatever it recorded is all there will ever be. */
    isAlive?: () => boolean;
  } = {}
): Promise<AskOutcome> {
  // Each poll is a full read+parse of the record home's whole
  // events.jsonl (every task, "delivered" payloads included), so the
  // interval is deliberately coarse: a few hundred milliseconds is
  // imperceptible to someone waiting on a real model call, and keeps
  // this from re-parsing the entire history a thousand times per
  // `fabrica do`.
  const { pollMs = 250, noticeMs = STILL_WAITING_INTERVAL_MS, onStillWaiting, isAlive } = opts;
  const foreman = createForeman({ recordHome });
  let nextNotice = Date.now() + noticeMs;

  for (;;) {
    // Read whether the process was alive before reading the record, so
    // an outcome it wrote just before exiting is never missed.
    const alive = isAlive ? isAlive() : true;
    const outcome = outcomeFrom(await foreman.events(taskId));
    if (outcome) return outcome;
    if (!alive) {
      return {
        status: "failed",
        questions: [],
        reason: `the task's process ended without recording an outcome - see ${recordHome}/cli.log`,
      };
    }
    if (onStillWaiting && Date.now() >= nextNotice) {
      onStillWaiting(STILL_WAITING_LINE);
      nextNotice = Date.now() + noticeMs;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function outcomeFrom(events: FabricaEvent[]): AskOutcome | undefined {
  // Rule 10 refuses before ask() ever runs, so this is checked first.
  const refused = events.find((e) => e.name === "cap-refused");
  if (refused) {
    const details = refused.details as { message?: string } | undefined;
    return { status: "cap-refused", questions: [], reason: details?.message ?? "a spending cap refused it" };
  }
  const asked = events.filter((e) => e.name === "questions-asked").at(-1);
  if (asked) {
    const details = asked.details as { questions?: string[] } | undefined;
    return { status: "asking", questions: details?.questions ?? [] };
  }
  const askFailed = events.filter((e) => e.name === "ask-failed").at(-1);
  if (askFailed) {
    const details = askFailed.details as { error?: string } | undefined;
    return { status: "failed", questions: [], reason: details?.error ?? "unknown error" };
  }
  const failed = events.filter((e) => e.name === "task-failed").at(-1);
  if (failed) {
    const details = failed.details as { message?: string } | undefined;
    return { status: "failed", questions: [], reason: details?.message ?? "unknown error" };
  }
  if (events.some((e) => e.name === "work-started")) return { status: "proceeding", questions: [] };
  return undefined;
}
