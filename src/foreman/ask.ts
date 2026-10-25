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
import { withTaskNetwork } from "../brain/index.ts";
import type { Brain, BrainAskResult } from "../brain/index.ts";
import { networkPolicyFor } from "./network-policy.ts";
import { ForemanError } from "./errors.ts";
import { requireRoomToStart } from "./caps.ts";
import { receiptModel, resolveModelChoice, writeModelChoice } from "./model.ts";
import { withTransportRetry } from "./transport-retry.ts";
import { requireMeterRoomToStart } from "./meters.ts";
import { markRecorded, recordingFailure, requireGitRoot } from "./task-failure.ts";
import { sweepTaskNetworks } from "./task-networks.ts";
import { fetchTaskIssue, parseIssueArgOrRefuse, withIssueText } from "./task-issue.ts";
import { knowledgeNotesFor, withKnowledge } from "./task-knowledge.ts";
import type { IssueReader } from "./task-issue.ts";
import type { Caps } from "../../contract/surface.ts";

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

/** Everything the "ask-failed" event's `details` carries (issue #8
 * follow-up, Client ruling): the real reason `brain.ask()` itself threw
 * - today's live path is the reference adapter's documented credential
 * gap, but this records whatever the plugged-in brain actually says. */
export interface AskFailedDetails {
  error: string;
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
  opts: {
    project: string;
    brain?: Brain;
    attempts?: number;
    /** The issue the chat agent names explicitly, the alternative to
     * `taskText` itself starting with "Issue #N:" - see
     * src/foreman/pr-body.ts's `closesIssueFor`. A number, or any
     * spelling src/github's `parseIssueArg` accepts (`owner/repo#N`, a
     * pasted issue URL). Its title and body are fetched here, once, and
     * persisted - nothing about it lives in `taskText` for a later
     * round to re-derive. */
    issue?: number | string;
    /** Where that issue is read from. Omitted uses the real GitHub,
     * with the token Inspector publishes with; tests supply a fake
     * (src/foreman/helpers/fake-issue-reader.ts) so no suite ever needs
     * a token or a network. */
    issueReader?: IssueReader;
    /** `fabrica do --model <name>` (issue #184) - the model this one
     * task asks for, outranking the project's own setting. Resolved
     * against projects.toml and persisted here, once, for every later
     * round to re-derive (see src/foreman/model.ts). */
    model?: string;
    caps?: Caps;
    onTaskRegistered?: (taskId: string) => void;
  }
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

  // The value's own shape, refused before anything is registered -
  // `resolveIssueRef` re-reads it below, once the project is known to be
  // a repository, to work out which repository it names.
  if (opts.issue !== undefined) parseIssueArgOrRefuse(opts.issue);

  const { id: taskId } = registerTask(recordHome, taskText);
  opts.onTaskRegistered?.(taskId);
  // Ownership split: registerTask (src/record) writes request.md as part
  // of registration - the record owns what the Client said. The Foreman
  // writes brief.md here, afterwards - the Foreman owns what a Worker is
  // actually given. Written upfront, before asking, so a later
  // `fabrica answer` only has to append a round to answers.md and
  // re-derive brief.md from what's already there.
  writeTaskFile(recordHome, taskId, "brief.md", taskText);
  // Issue #184: which model this task asked for, and where that came
  // from, resolved once here - the flag beats the project's setting,
  // and a task that declared neither records that as a fact too, the
  // same way caps.json below does. Every later round reads it back
  // rather than re-resolving against a projects.toml that may have
  // changed under it.
  const modelChoice = resolveModelChoice(recordHome, opts.project, opts.model);
  writeModelChoice(recordHome, taskId, modelChoice);
  // Rule 10's numbers as of this moment, persisted once (issue #203):
  // these are the caps this task is actually held to, and a cost meter
  // read weeks later should show the ceiling that applied rather than
  // whatever projects.toml says by then. Written for every task, caps
  // set or not, so "no cap" is recorded as a fact rather than as a
  // missing file that could equally mean "an older task".
  writeTaskFile(recordHome, taskId, "caps.json", JSON.stringify(opts.caps ?? {}));

  return recordingFailure(recordHome, taskId, async () => {
    // Before anything spends, the clarifying step included: the project
    // must be a real git repository's root.
    requireGitRoot(opts.project);

    // Rule 10: refused before anything spends - ask() itself costs money
    // on a metered brain. Registered first so the refusal, with its
    // numbers, lands on this task's own record (`fabrica log <id>`).
    requireRoomToStart(recordHome, taskId, opts.caps, { project: opts.project });

    // Issue #189, right behind it and for the same reason: a flat-rate
    // subscription's own window is something no dollar cap can see, so
    // it is checked separately. Fails open on a reading nobody could
    // use (see meters.ts) - never refuses on an unread number.
    requireMeterRoomToStart(recordHome, taskId, { project: opts.project });

    // The issue this task names, read once and frozen (Client ruling:
    // "fetched once at registration and frozen for the life of the task
    // ... an issue edited later is a new task"). Persisted to the record
    // here - both the issue's own words and what a pull request should
    // close - so every later round, including a fix round in another
    // process, reads it back rather than asking GitHub again.
    //
    // Deliberately placed here, after the guards and before the
    // clarifying step: a task whose issue cannot be read is refused
    // before any ProductionLine is cut and before anything spends,
    // naming the cause (ForemanError("issue-unavailable"), recorded as
    // "task-failed" by the wrapper around this body), and the clarifying
    // step itself is handed the issue's words - the whole point of
    // fetching it, since a task worded "do issue #N as written" would
    // otherwise have to ask what #N says.
    const issueText =
      opts.issue === undefined
        ? undefined
        : await fetchTaskIssue(recordHome, taskId, opts.project, opts.issue, opts.issueReader);

    // The knowledge-base notes this project names, read off the disk
    // here and handed to the clarifying step along with the task's own
    // words: a Worker's brief carries the same section on every round
    // (do.ts/verdict.ts, via `withKnowledge`), so the step deciding
    // whether the task is clear reads what the work will read.
    //
    // Placed with the issue fetch and for the same reason: a project
    // whose named notes cannot be read refuses here, before any
    // ProductionLine is cut and before anything spends, naming the note
    // or the folder (ForemanError("knowledge-unavailable"), recorded as
    // "task-failed" by the wrapper around this body).
    const knowledgeNotes = knowledgeNotesFor(recordHome, opts.project);

    // A task must never look started when its very first step never ran -
    // "ask-failed" is what lets an outside observer (fabrica do's own
    // process, src/cli/wait-for-ask-outcome.ts) tell that apart from
    // "still thinking," instead of the record staying silent at
    // "task-received" while this throws and the CLI's bounded wait times
    // out into a false success (Client ruling, issue #8 follow-up: a
    // failed task must never look like a started one). Rethrown after
    // recording, unchanged - every direct caller of registerAndAsk/doTask
    // still sees the real error; only the record gains a trace of it.
    let asked: BrainAskResult;
    const askStartedAt = new Date().toISOString();
    try {
      // Issue #186: the clarifying step is a real model call over the
      // real relay, so it runs under this task's own network policy
      // too - a host it is refused lands on this task's record, not
      // nowhere. Nothing about `ask(brief)`'s own ratified signature
      // changes; see src/brain/task-network.ts.
      asked = await withTaskNetwork(networkPolicyFor(recordHome, taskId, opts.project), () =>
        // Issue #199: this call is as droppable as a worker's own, and
        // gets the same one retry on the same model, recorded. Both
        // failing throws ForemanError("model-call-failed"), which the
        // catch below records as this task's "ask-failed" - naming the
        // model and the real error, rather than leaving a task dead
        // with nothing said about why.
        withTransportRetry(
          () =>
            // The task's own words plus the issue they refer to, in
            // full, plus the project's knowledge notes - every round's
            // worker brief carries the same sections (do.ts/verdict.ts,
            // via `withIssueText`/`withKnowledge`), so the clarifying
            // step and the work see the same request and the same
            // notes.
            brain.ask(withKnowledge(withIssueText(taskText, issueText), knowledgeNotes)),
          {
            which: "ask",
            model: receiptModel(modelChoice.declaredModel, brain.model),
            onRetry: (details) => appendEvent(recordHome, { taskId, name: "transport-retry", details }),
          }
        )
      );
    } catch (err) {
      const details: AskFailedDetails = { error: err instanceof Error ? err.message : String(err) };
      appendEvent(recordHome, { taskId, name: "ask-failed", details });
      throw markRecorded(err);
    } finally {
      // The clarifying step is a real model call, so it opens this
      // task's worker networks too (`withTaskNetwork` above is what
      // puts this task's id on them) - and it runs before any
      // ProductionLine exists, so there is no line teardown to sweep
      // after it. A task that stops here to ask leaves none behind
      // either way. See ./task-networks.ts.
      await sweepTaskNetworks(taskId);
    }
    // Rule 10: the clarifying step spends too. A cost the brain did not
    // report (null or absent) is recorded as unknown - never as zero.
    const costUsd =
      typeof asked.costUsd === "number" && Number.isFinite(asked.costUsd) && asked.costUsd >= 0 ? asked.costUsd : null;
    appendEvent(recordHome, { taskId, name: "ask-cost-recorded", details: { costUsd, startedAt: askStartedAt } });
    const questions = (asked.questions ?? []).filter((q) => q.trim().length > 0);

    if (questions.length > 0) {
      const details: AskedDetails = { questions, project: opts.project, totalAttempts, explicitAttempts };
      appendEvent(recordHome, { taskId, name: "questions-asked", details });
    }

    return { taskId, brief: taskText, questions, project: opts.project, totalAttempts, explicitAttempts };
  });
}
