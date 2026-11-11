// Reading GitHub's two vocabularies, in one place, so no caller gets to
// invent a third.
//
// A check run's `conclusion` (documented enum): success, failure,
// neutral, cancelled, skipped, timed_out, action_required, or null while
// it is still running. A commit status's `state` (documented enum):
// error, failure, pending, success.

/** The conclusions that are NOT red. Everything else is.
 *
 * `neutral` and `skipped` are deliberately here: a skipped job is the
 * repository itself saying this check does not apply to this change, and
 * a neutral one is a check declining to judge. Treating either as red
 * would make Fabrica override the repository's own decision about which
 * checks exist, which issue #267 lists as a non-goal. `timed_out` and
 * `action_required` are red: in each, a check that was supposed to
 * answer did not pass, and calling that green is exactly the lie the
 * fourth ask forbids. */
const NOT_RED_CONCLUSIONS: ReadonlySet<string> = new Set(["success", "neutral", "skipped"]);

/** The conclusion that is not an answer at all (issue #348). A cancelled
 * run was stopped before it could judge anything - overwhelmingly by a
 * newer run of the same workflow on the same commit, which is what
 * `concurrency: cancel-in-progress` does on every push and every
 * description edit - so there is nothing in it to read either way.
 *
 * It is dropped before the check's answer is chosen (`latest.ts`), which
 * is why `isRedConclusion` below still answers "red" for it: a caller
 * that has not filtered it must err red rather than green, exactly like
 * a word this code has never seen. */
const NOT_A_RESULT_CONCLUSIONS: ReadonlySet<string> = new Set(["cancelled"]);

/** Whether a concluded check (either mechanism) counts as red. The
 * conclusion is matched case-insensitively and trimmed - the value is
 * GitHub's, not Fabrica's, and a shape change should not quietly flip a
 * red to green. An empty or unrecognized word is red: an answer nobody
 * here understands is the one case that must not be read as a pass. */
export function isRedConclusion(conclusion: string): boolean {
  return !NOT_RED_CONCLUSIONS.has(conclusion.trim().toLowerCase());
}

/** Whether this conclusion is no result at all, so the check it belongs
 * to is still waiting on the newest run of itself. Matched the same
 * trimmed, case-insensitive way `isRedConclusion` matches, and for the
 * same reason. A commit status can never be one of these - its
 * documented states are error, failure, pending and success, with no
 * equivalent - so only check runs are ever asked. */
export function isNoResultConclusion(conclusion: string): boolean {
  return NOT_A_RESULT_CONCLUSIONS.has(conclusion.trim().toLowerCase());
}

/** The check-run statuses that mean "no answer yet". `completed` is the
 * only status that carries a conclusion; the rest - queued, in_progress,
 * waiting, requested, pending - are all still to come. */
export function isUnresolvedCheckRunStatus(status: string): boolean {
  return status.trim().toLowerCase() !== "completed";
}

/** The one commit-status state that means "no answer yet". */
export function isUnresolvedCommitStatusState(state: string): boolean {
  return state.trim().toLowerCase() === "pending";
}
