// What happens when the warm worker a `fix` verdict wants to re-enter is
// no longer there (issue #353).
//
// CONTRACT rule 6's "fix" hands the Client's note back to the SAME warm
// worker on the same line, so a correction keeps the context the first
// round built up rather than re-discovering it. That context lives in a
// resumable session the brain owns, and a session does not live forever:
// issue #353 was a task delivered the day before, ruled `fix` about
// twenty hours later, whose session had ended in the meantime. There was
// no way left to send a correction to that delivery at all, which breaks
// deliver-review-fix for any review slower than a session's life.
//
// The Client's ruling on the issue's own clarification: start a fresh
// worker with the task's history and the note. Not refuse, and not offer
// a flag.
//
// Nothing is lost by starting cold, and that is worth knowing rather than
// hoping: `src/foreman/verdict.ts`'s `buildFixBrief` already composes the
// task's ORIGINAL brief - the request, the issue's own words, the files
// the task was handed, the project's knowledge notes - with the Client's
// note, on every pass of every fix round, and the branch already carries
// every prior round's commits. The warm session was an optimisation on
// top of a brief that always carried the history, never the only copy of
// it. A cold restart is the same brief and the same tree, minus the
// previous round's conversation.
//
// The classifier below is an ALLOWLIST, for the same reason
// ./transport-retry.ts's is (and this module is deliberately shaped after
// it: one narrow decision about one failed model call, made by the
// Foreman rather than by a brain, recorded, and never counted as an
// attempt). A wording wrongly left out costs one honest failure the
// Client can rule on again; a wording wrongly let in re-runs a whole
// worker call cold - real money, and a worker made to throw away context
// it still had.
//
// Why here and not in an adapter: an adapter dropping `--resume` by
// itself would be fewer lines and no event, and the Client would silently
// get a cold worker where he paid for a warm one, with nothing on the
// record to say so - and only in whichever adapter happened to implement
// it. CONTRACT rule 8 means that decision cannot live there.

import { ForemanError } from "./errors.ts";

/** What a `"warm-worker-restarted"` event carries. `reason` is Fabrica's
 * own short phrase for what kind of refusal this was; `error` is the
 * failed call's own message, verbatim, so the record never paraphrases a
 * brain into something it did not say. */
export interface WarmWorkerRestartedDetails {
  /** The session that could not be resumed, named so the record says
   * which warm worker was being asked for. */
  session: string;
  reason: string;
  error: string;
  /** The attempt whose call was restarted cold. A restart is NOT an
   * attempt of its own: it happens inside one turn of the counted loop
   * (CONTRACT rule 3 counts attempts, not restarts), so this is the
   * number the attempt already had. */
  attempt?: number;
}

/** The wordings that mean "the session named by this call is not there
 * any more". Each is a shape a real session-resuming tool produces: a
 * CLI-family adapter passes its tool's own refusal straight through
 * (`src/brain/adapters/`), so these are the sentences that arrive. No
 * adapter, tool or vendor is named here - CONTRACT rule 8 permits that
 * only under `src/brain/adapters/`.
 *
 * `--resume`/`--continue` appearing in a refusal is deliberately NOT on
 * its own enough: a tool can mention the flag while refusing for some
 * other reason entirely. */
const SESSION_GONE: [RegExp, string][] = [
  [/no (?:conversation|session|chat|thread)\b[^.\n]{0,40}\bfound/i, "the session no longer exists"],
  [/(?:conversation|session|chat|thread)\b[^.\n]{0,40}\bnot found/i, "the session no longer exists"],
  [/(?:conversation|session|chat|thread)\b[^.\n]{0,40}\b(?:does not|doesn't) exist/i, "the session no longer exists"],
  [/(?:unknown|unrecognized|unrecognised|invalid) (?:conversation|session|chat|thread)\b/i, "the session id was not recognized"],
  [/(?:conversation|session|chat|thread)\b[^.\n]{0,40}\bexpired/i, "the session had expired"],
  [/(?:could not|cannot|unable to) (?:resume|restore|load|read) (?:the )?(?:conversation|session|chat|thread)\b/i, "the session could not be resumed"],
  [/(?:conversation|session|chat|thread)\b[^.\n]{0,40}\b(?:no longer (?:available|exists)|has (?:ended|been deleted))/i, "the session no longer exists"],
];

/** How far down an error's `cause` chain this looks - the same bound and
 * the same reason as ./transport-retry.ts's: a refusal wrapped by an
 * adapter's own typed error is a level or two down, and the bound is a
 * cycle guard rather than a judgement about depth. */
const MAX_CAUSE_DEPTH = 5;

function messagesOf(err: unknown): string {
  const messages: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth++) {
    if (typeof current === "string") {
      messages.push(current);
      break;
    }
    if (typeof current !== "object") break;
    const asRecord = current as { message?: unknown; cause?: unknown };
    if (typeof asRecord.message === "string") messages.push(asRecord.message);
    current = asRecord.cause;
  }
  return messages.join("\n");
}

/**
 * The short phrase naming why the warm worker's session could not be
 * resumed, or `undefined` when this error says nothing of the kind -
 * which is the answer for anything the allowlist above does not
 * recognize.
 *
 * A `ForemanError` is never one of these: those are Fabrica's own
 * refusals about its own state (a cap, a dead relay, a failed commit, a
 * rebase it would not run), none of which is a brain declining to resume
 * a session, and none of which becomes true or false by asking again
 * without one. Same first rule ./transport-retry.ts applies, for the
 * same reason.
 */
export function sessionGoneReason(err: unknown): string | undefined {
  if (err instanceof ForemanError) return undefined;
  const text = messagesOf(err);
  for (const [pattern, reason] of SESSION_GONE) {
    if (pattern.test(text)) return reason;
  }
  return undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs `call` with the warm worker's session, and - if that fails because
 * the session is gone - exactly once more with no session at all, so the
 * round goes ahead with a fresh worker on the task's own history and the
 * Client's note instead of dying.
 *
 * `call` takes the session to use rather than closing over one, so the
 * cold call genuinely builds its own options: passing a session the brain
 * has just refused is the bug this exists to fix.
 *
 * Deliberately not a loop: there is one fallback here, from warm to cold.
 * A cold call that fails has nothing left to fall back to, and its own
 * error is the honest answer - reported as it is, since the record
 * already says a cold restart was made (`onRestart` fires before it).
 *
 * Call this OUTSIDE ./transport-retry.ts's `withTransportRetry`, which is
 * what `src/foreman/attempts.ts` does: a dropped connection is retried
 * warm first - nothing about the session is wrong - and only a genuine
 * session refusal falls back to cold. The cold call gets its own
 * transport retry for free, since it goes through the same wrapper.
 *
 * Named bound of that order: a call whose FIRST failure was a transport
 * error and whose transport retry then found the session gone comes back
 * as `ForemanError("model-call-failed")` with the refusal inside it, and
 * is not restarted cold - the `ForemanError` rule above sees to that. The
 * round fails honestly, the ruling is already recorded, and the next
 * `fix` meets the dead session on its own first call and restarts there.
 * Reaching into that wrapper's own failure to classify what it wrapped
 * would make one retry's outcome depend on the other's, which is not
 * worth it for a window this narrow.
 */
export async function withColdStartFallback<T>(
  call: (session: string | undefined) => Promise<T>,
  opts: {
    /** The warm worker's session, or undefined when there is none to
     * resume - a first round, which then has nothing to fall back from
     * and makes exactly one call. */
    session: string | undefined;
    /** Appends the `"warm-worker-restarted"` event. Called before the
     * cold call is made, so the record says a restart is happening
     * rather than reporting it only once it has succeeded. */
    onRestart: (details: WarmWorkerRestartedDetails) => void;
  }
): Promise<T> {
  const { session } = opts;
  if (session === undefined) return call(undefined);

  try {
    return await call(session);
  } catch (err) {
    const reason = sessionGoneReason(err);
    // Not a dead session: an honest failure, reported as it is. Starting
    // cold here would re-run a worker call for a reason that has nothing
    // to do with the session.
    if (reason === undefined) throw err;
    opts.onRestart({ session, reason, error: messageOf(err) });
    return call(undefined);
  }
}
