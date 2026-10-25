// Shadow mode (issue #204's amendment, Client ruling 2026-10-25): the
// evaluator runs after every delivery, answers every condition, and
// writes down what it would have done.
//
// NOTHING CLOSES HERE. There is no merge, no `closed-by-rule`, no
// verdict, and no code path in this module that could reach one: it
// appends one event and returns. Every task still goes to the Client
// exactly as it did before, and the only observable difference is a
// `would-close-by-rule` line on the record and the counts the surfaces
// read off it. The real path is a follow-up behind the graduation
// proposal, and CONTRACT rule 6 is the Client's to amend before any of
// it is turned on.
//
// It also never throws into the round. A delivery has already landed by
// the time this runs; losing it to a mistyped rules file would be a far
// worse failure than not evaluating. So a refusal is recorded as the
// event's own `problem` - loudly, where `fabrica shadow-report`,
// `fabrica log` and the live view all show it - rather than raised.

import { appendEvent, readEventsForTask } from "../record/index.ts";
import { SkipRuleError } from "./errors.ts";
import { changeCounts, changeFingerprint } from "./git.ts";
import { closingKind, evaluateRules } from "./evaluate.ts";
import { factsFromRecord } from "./facts.ts";
import { loadSkipRules, SKIP_RULES_PATH } from "./load.ts";
import type { WouldCloseByRuleDetails } from "./types.ts";

export interface ShadowEvaluationRequest {
  recordHome: string;
  taskId: string;
  /** Resolved path of the Client's own checkout - where both git reads
   * run, and where the rules file is read from. Never the throwaway
   * worktree: the caller destroys that immediately after the round, and
   * its copy of the rules file is one the worker could have written. */
  project: string;
  /** The commit the ProductionLine was cut from. Both the revision the
   * rules file is read at and the fork point the diff is taken from. */
  baseCommit: string;
  /** `fabrica/<taskId>` - the branch the delivery names. */
  branch: string;
}

/**
 * Evaluates this task's delivery against the project's skip rules and
 * records the answer. Returns the details it appended, or null when the
 * project has no rules file at all - the ordinary case, which appends
 * nothing: a project that never opted in gets no events it did not ask
 * for, and no existing record changes shape.
 */
export function evaluateInShadow(request: ShadowEvaluationRequest): WouldCloseByRuleDetails | null {
  const { recordHome, taskId, project, baseCommit, branch } = request;

  let details: WouldCloseByRuleDetails;
  try {
    const rules = loadSkipRules(project, baseCommit);
    if (rules === null) return null;

    // The amendment's "one `git diff --stat` for counts", plus the
    // change's own patch-id fingerprint. Both read-only, both answered
    // null rather than thrown on failure.
    const facts = factsFromRecord(readEventsForTask(recordHome, taskId), changeCounts(project, baseCommit, branch));
    const kinds = evaluateRules(rules, facts);
    const closing = closingKind(kinds);

    details = {
      project,
      rulesPath: rules.path,
      rulesVersion: rules.rulesVersion,
      fingerprint: changeFingerprint(project, baseCommit, branch),
      mode: "shadow",
      wouldClose: closing !== null,
      closedByKind: closing,
      kinds,
    };
  } catch (err) {
    details = {
      project,
      rulesPath: SKIP_RULES_PATH,
      rulesVersion: null,
      fingerprint: null,
      mode: "shadow",
      wouldClose: false,
      closedByKind: null,
      kinds: [],
      problem: err instanceof SkipRuleError ? err.message : `${SKIP_RULES_PATH} could not be evaluated: ${messageOf(err)}`,
    };
  }

  appendEvent(recordHome, { taskId, name: "would-close-by-rule", details });
  return details;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
