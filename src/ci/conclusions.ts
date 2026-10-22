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
 * checks exist, which issue #267 lists as a non-goal. `cancelled`,
 * `timed_out` and `action_required` are red: in each, a check that was
 * supposed to answer did not pass, and calling that green is exactly the
 * lie the fourth ask forbids. */
const NOT_RED_CONCLUSIONS: ReadonlySet<string> = new Set(["success", "neutral", "skipped"]);

/** Whether a concluded check (either mechanism) counts as red. The
 * conclusion is matched case-insensitively and trimmed - the value is
 * GitHub's, not Fabrica's, and a shape change should not quietly flip a
 * red to green. An empty or unrecognized word is red: an answer nobody
 * here understands is the one case that must not be read as a pass. */
export function isRedConclusion(conclusion: string): boolean {
  return !NOT_RED_CONCLUSIONS.has(conclusion.trim().toLowerCase());
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
