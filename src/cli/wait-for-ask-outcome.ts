// After spawnDetachedTask resolves with a taskId, the detached child is
// still running doTask() (src/foreman/do.ts) - which now (issue #8) does
// register -> ask -> maybe isolate/work, all inside that one call. This
// polls the task's own record for whichever of three outcomes lands
// first, so `fabrica do` can print numbered questions and stop (SPEC.md
// step 2), or report a real failure, instead of only ever printing the
// task id.
//
// The timeout is for the genuinely-slow-brain case only, and it is
// exactly that - a real timeout, not a stand-in for "the task failed."
// A brain that throws (src/foreman/ask.ts's "ask-failed", e.g. the
// reference adapter's documented credential gap - the live path today)
// is detected directly and reported as "failed", never left to exhaust
// the clock. Only a brain that is simply slow, or a task that fails for
// an unrelated reason before ever reaching "work-started" (e.g. a
// missing check command - a known, separate gap this does not close),
// falls through to the timeout, which still resolves "proceeding" - the
// task itself is unaffected by what this observes, and keeps running
// (or, in that separate gap's case, has already failed silently
// upstream of what this function can see).

import { createForeman } from "../index.ts";

export interface AskOutcome {
  status: "asking" | "proceeding" | "failed";
  /** Populated only when status is "asking". */
  questions: string[];
  /** Populated only when status is "failed" - brain.ask()'s own error
   * message, verbatim (src/foreman/ask.ts's "ask-failed" event). */
  reason?: string;
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
    const failed = events.filter((e) => e.name === "ask-failed").at(-1);
    if (failed) {
      const details = failed.details as { error?: string } | undefined;
      return { status: "failed", questions: [], reason: details?.error ?? "unknown error" };
    }
    if (events.some((e) => e.name === "work-started")) {
      return { status: "proceeding", questions: [] };
    }
    if (Date.now() >= deadline) return { status: "proceeding", questions: [] };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
