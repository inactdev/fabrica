// SPEC.md step 1 ("Registers") and step 2 ("Clarify-or-proceed", issue
// #8): together because doTask always wants both done before deciding
// what happens next, and because step 2 needs the taskId step 1 claims
// in order to write "questions-asked" onto that task's own record. The
// CLI never calls this itself - it reads the outcome back off that
// record instead (src/cli/wait-for-ask-outcome.ts).
//
// Brain.ask takes no workdir - by construction, this call cannot touch
// any project, so CONTRACT rule 1 ("it never touches your stuff") holds
// here without relying on the brain's own good behavior. "Materially
// ambiguous" - the load-bearing phrase - means an ambiguity that would
// change what gets built, not one a reasonable person would resolve the
// same way every time; drawing that line is the brain's job (see the
// reference adapter's own ask()-prompt builder for how it states this),
// not this module's.

import { appendEvent, registerTask, writeTaskFile } from "../record/index.ts";
import type { Brain } from "../brain/index.ts";
import { ForemanError } from "./errors.ts";

/** SPEC.md step 5's default: one attempt, and on red one fix pass with
 * the failure output, then re-check - a ceiling of 2 worker runs. */
export const DEFAULT_ATTEMPTS = 2;

/** Everything the "questions-asked" event's `details` carries - a later
 * `fabrica answer` needs `project`/`totalAttempts`/`explicitAttempts`
 * back to resume the task exactly as `do()` would have run it, since no
 * ProductionLine was ever cut to remember them on. */
export interface AskedDetails {
  questions: string[];
  project: string;
  totalAttempts: number;
  explicitAttempts: boolean;
}

export interface RegisterAndAskResult {
  taskId: string;
  /** request.md's content - identical to brief.md at this point, since
   * no answer round has happened yet. */
  brief: string;
  /** Empty when the task is clear enough to proceed straight to work. */
  questions: string[];
  project: string;
  totalAttempts: number;
  explicitAttempts: boolean;
}

/**
 * Registers the task, then gives a brain one pass at the bare task text
 * to decide whether it needs clarification. When it does, this already
 * writes "questions-asked" onto the record before returning - the
 * caller's only job left is to stop (return the "asking" state) rather
 * than isolate or work.
 */
export async function registerAndAsk(
  recordHome: string,
  taskText: string,
  opts: { project: string; brain?: Brain; attempts?: number }
): Promise<RegisterAndAskResult> {
  const brain = opts.brain;
  if (!brain) {
    throw new ForemanError(
      "no-brain",
      "fabrica do: no brain was provided, and v1 has no default adapter wired in yet " +
        "(issue #6 builds the first one). Pass one explicitly."
    );
  }

  const explicitAttempts = opts.attempts !== undefined;
  if (explicitAttempts && (!Number.isInteger(opts.attempts) || opts.attempts! < 1)) {
    throw new ForemanError(
      "invalid-attempts",
      `fabrica do: attempts must be a positive integer, got ${opts.attempts}.`
    );
  }
  const totalAttempts = opts.attempts ?? DEFAULT_ATTEMPTS;

  const { id: taskId } = registerTask(recordHome, taskText);
  // Ownership split: registerTask (src/record) writes request.md as part
  // of registration - the record owns what the Client said. The Foreman
  // writes brief.md here, afterwards - the Foreman owns what a Worker is
  // actually given. Written upfront, before asking, so a later
  // `fabrica answer` only has to append a round to answers.md and
  // re-derive brief.md from what's already there.
  writeTaskFile(recordHome, taskId, "brief.md", taskText);

  const { questions: asked } = await brain.ask(taskText);
  const questions = (asked ?? []).filter((q) => q.trim().length > 0);

  if (questions.length > 0) {
    const details: AskedDetails = { questions, project: opts.project, totalAttempts, explicitAttempts };
    appendEvent(recordHome, { taskId, name: "questions-asked", details });
  }

  return { taskId, brief: taskText, questions, project: opts.project, totalAttempts, explicitAttempts };
}
