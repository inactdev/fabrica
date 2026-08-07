// After spawnDetachedTask resolves with a taskId, the detached child is
// still running doTask() (src/foreman/do.ts) - which now (issue #8) does
// register -> ask -> maybe isolate/work, all inside that one call. This
// polls the task's own record for whichever of those two outcomes lands
// first, so `fabrica do` can print numbered questions and stop (SPEC.md
// step 2) instead of only ever printing the task id.
//
// A bounded wait, not an indefinite one: ask() is a real call to
// whichever brain is wired in, and nothing here should hang the
// terminal forever if it's slow, or if the task fails before ever
// reaching "work-started" for an unrelated reason (e.g. a missing check
// command). Either way, falling back to "proceeding" (print just the
// id) is exactly today's pre-#8 behavior - a timeout here is a UX
// degradation, never a wrong answer: the task itself is unaffected and
// keeps running in the background regardless of what this observes.

import { createForeman } from "../index.ts";

export interface AskOutcome {
  status: "asking" | "proceeding";
  /** Populated only when status is "asking". */
  questions: string[];
}

export async function waitForAskOutcome(
  recordHome: string,
  taskId: string,
  opts: { timeoutMs?: number; pollMs?: number } = {}
): Promise<AskOutcome> {
  // Each poll is a full read+parse of the record home's whole
  // events.jsonl (every task, "delivered" payloads included), so the
  // interval is deliberately coarse: a few hundred milliseconds is
  // imperceptible to someone waiting on a real model call, and keeps
  // this from re-parsing the entire history a thousand times per
  // `fabrica do`.
  const { timeoutMs = 60_000, pollMs = 250 } = opts;
  const foreman = createForeman({ recordHome });
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const events = await foreman.events(taskId);
    const asked = events.filter((e) => e.name === "questions-asked").at(-1);
    if (asked) {
      const details = asked.details as { questions?: string[] } | undefined;
      return { status: "asking", questions: details?.questions ?? [] };
    }
    if (events.some((e) => e.name === "work-started")) {
      return { status: "proceeding", questions: [] };
    }
    if (Date.now() >= deadline) return { status: "proceeding", questions: [] };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
