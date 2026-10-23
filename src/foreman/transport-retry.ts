// One retry on a transport failure, on the same model, recorded (issue
// #199). Two tasks in two days were lost to a connection that closed
// mid-response (#139, #168): the model had done the work, the answer was
// on its way back, and the task died on the last few bytes of it.
//
// The rule this implements is narrow on purpose:
//
//   - A transport failure - the call never got an answer - is retried
//     exactly once, after a short wait, against the SAME model.
//   - A request-level refusal - the model API answered, and its answer
//     was "no" (an auth rejection, a context-length refusal, a malformed
//     request) - is never retried. Nothing about trying it again would
//     change the answer.
//   - Every retry lands on the record as a "transport-retry" event with
//     its reason, and is never counted as an attempt: CONTRACT rule 3 is
//     about attempts, not reconnects, so this runs INSIDE one attempt of
//     the Foreman's counted loop and leaves its numbers alone.
//   - If the retry fails too, the task stops with a failure naming the
//     model and the error. Fabrica never switches to another model on
//     its own - that is a decision someone makes, with a record behind
//     it.
//
// Which failures count as which is the Client's own ruling (2026-10-23):
// retried - a connection closed mid-response, a connect or read timeout,
// any 5xx (529's "overloaded" included), and 429; failed immediately -
// auth rejections, context-length refusals, and any other request-level
// refusal.
//
// The classifier is an ALLOWLIST: an error shape it does not recognize
// is not a transport failure and fails at once. The standing ruling is
// that everything fails loudly, and the asymmetry points the same way -
// a shape wrongly left out costs one honest failure, while a shape
// wrongly let in re-runs a whole worker call (real money, real time,
// possibly duplicate work) every time it appears.

import { ForemanError } from "./errors.ts";

/** How long the one retry waits before it is made. Short enough that a
 * task does not sit idle on a blip, long enough that it is not the
 * instant hammer-back that makes an overloaded or rate-limiting API
 * worse - the two cases this covers most often. */
export const TRANSPORT_RETRY_WAIT_MS = 5_000;

/** Which of Fabrica's own two model calls this was. Both go through the
 * same socket (`Brain`), and both can be dropped the same way. */
export type ModelCall = "work" | "ask";

/** What a "transport-retry" event carries. The reason is Fabrica's own
 * short phrase for what kind of failure it was; `error` is the failed
 * call's own message, verbatim, so the record never paraphrases a brain
 * into something it did not say. */
export interface TransportRetryDetails {
  call: ModelCall;
  reason: string;
  error: string;
  /** The model the dropped call was made against - the task's own
   * declaration where it has one, else the brain's label, else
   * "unknown" (never a model nobody chose). */
  model: string;
  /** How long the retry waited first. */
  waitMs: number;
  /** The attempt the retried call belongs to. Set for "work" only: a
   * clarifying call happens before any attempt exists. */
  attempt?: number;
}

/** Statuses that mean "not now" rather than "no": the rate limit, the
 * server-side request timeout, and every 5xx - which is how 529
 * ("overloaded") is covered without naming any one provider's own
 * spelling of it. Everything else the API answers is an answer. */
function retryableStatus(status: number): string | undefined {
  if (status === 429) return "the model API answered 429 (rate limited)";
  if (status === 408) return "the model API answered 408 (request timeout)";
  if (status >= 500 && status < 600) return `the model API answered ${status}`;
  return undefined;
}

/** Where a status code can be read out of an error's own words. Each
 * pattern is one a real adapter in this repository produces:
 * `api_error_status` is the reference CLI adapter's (it copies the field
 * straight off the tool's own result line), `answered <n>` is the
 * direct-API adapter's. The rest are the ordinary spellings an adapter
 * added later is likely to use. A new adapter that words it differently
 * belongs in this list - that is the one place to look when a transport
 * failure was not retried. (No adapter is named here: CONTRACT rule 8
 * permits naming one only under `src/brain/adapters/`.) */
const STATUS_PATTERNS: RegExp[] = [
  /api[_ ]?error[_ ]?status[ :=]+(\d{3})\b/i,
  /\banswered (\d{3})\b/i,
  /\bapi error[ :]+(\d{3})\b/i,
  /\bhttp(?:\/\d(?:\.\d)?)?[ :]+(\d{3})\b/i,
  /\bstatus(?: code)?[ :=]+(\d{3})\b/i,
];

/** A real answer from the model API, however it is worded: trying again
 * gets the same one. Checked BEFORE the connection phrases below, so a
 * refusal whose body text happens to mention a connection or a timeout
 * is still never retried. */
const REQUEST_REFUSALS: RegExp[] = [
  /context[ _-]?length/i,
  /prompt is too long/i,
  /too many tokens/i,
  /invalid[ _-]?api[ _-]?key/i,
  /invalid[ _-]?request/i,
  /\bunauthorized\b/i,
  /\bauthenticat/i,
  /\bforbidden\b/i,
  /credit balance/i,
  /\bnot authorized\b/i,
];

/** Node's own codes for a call that never got its answer. Read off
 * `err.code` anywhere in the `cause` chain - a `fetch` failure reports
 * nothing useful in its own message and carries the real code one level
 * down. `ECONNREFUSED` is deliberately absent: nothing was listening,
 * which does not change in five seconds, and in this codebase that is
 * the shape a dead per-task relay produces - already reported honestly
 * and at once by `ForemanError("worker-network-gone")`. */
const RETRYABLE_CODES = new Map<string, string>([
  ["ECONNRESET", "the connection was reset"],
  ["ECONNABORTED", "the connection was aborted"],
  ["EPIPE", "the connection closed mid-response"],
  ["ERR_STREAM_PREMATURE_CLOSE", "the connection closed mid-response"],
  ["UND_ERR_SOCKET", "the connection closed mid-response"],
  ["ETIMEDOUT", "the call timed out"],
  ["ESOCKETTIMEDOUT", "the call timed out"],
  ["UND_ERR_CONNECT_TIMEOUT", "the call timed out"],
  ["UND_ERR_HEADERS_TIMEOUT", "the call timed out"],
  ["UND_ERR_BODY_TIMEOUT", "the call timed out"],
]);

/** The wordings of the same two things. "Connection closed mid-response"
 * is the exact sentence #139 and #168 died on. */
const TRANSPORT_PHRASES: [RegExp, string][] = [
  [/connection closed/i, "the connection closed mid-response"],
  [/socket hang ?up/i, "the connection closed mid-response"],
  [/premature close/i, "the connection closed mid-response"],
  [/connection (?:was )?reset/i, "the connection was reset"],
  [/connection (?:was )?aborted/i, "the connection was aborted"],
  [/stream (?:was )?(?:closed|interrupted)/i, "the connection closed mid-response"],
  [/timed ?out/i, "the call timed out"],
  [/\btimeout\b/i, "the call timed out"],
  [/no response within/i, "the call timed out"],
];

/** How far down an error's `cause` chain this looks. A wrapped transport
 * failure is normally one or two levels down (an adapter's own typed
 * error around a fetch failure around a socket error); the bound is a
 * cycle guard, not a judgement about depth. */
const MAX_CAUSE_DEPTH = 5;

interface ErrorFacts {
  text: string;
  codes: string[];
  statuses: number[];
}

/** Everything the classifier reads, gathered from the error and its
 * `cause` chain in one pass: all the messages as one blob of text, every
 * `code`, and every numeric `status`/`statusCode` an HTTP client may
 * have attached. */
function factsOf(err: unknown): ErrorFacts {
  const messages: string[] = [];
  const codes: string[] = [];
  const statuses: number[] = [];

  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth++) {
    if (typeof current === "string") {
      messages.push(current);
      break;
    }
    if (typeof current !== "object") break;
    const asRecord = current as { message?: unknown; code?: unknown; status?: unknown; statusCode?: unknown; cause?: unknown };
    if (typeof asRecord.message === "string") messages.push(asRecord.message);
    if (typeof asRecord.code === "string") codes.push(asRecord.code);
    for (const value of [asRecord.status, asRecord.statusCode]) {
      if (typeof value === "number" && Number.isInteger(value)) statuses.push(value);
    }
    current = asRecord.cause;
  }

  return { text: messages.join("\n"), codes, statuses };
}

/**
 * The short phrase naming what kind of transport failure this was, or
 * `undefined` when it is not one - a request-level refusal, or anything
 * this does not recognize (see the allowlist reasoning at the top of
 * this file).
 *
 * The order is the point:
 *
 * 1. A `ForemanError` is Fabrica's own refusal about its own state (a
 *    dead relay, a failed commit, a cap). None of them are a model call
 *    that did not arrive, and none become true on a second try.
 * 2. A status the API actually answered with decides on its own, either
 *    way - so a 503 is retried however its body is worded, and a 401 is
 *    not, however its body is worded.
 * 3. Only then the phrases, which are guesses from text rather than
 *    facts from a field, and only after the refusal wordings have had
 *    their say.
 */
export function transportFailureReason(err: unknown): string | undefined {
  if (err instanceof ForemanError) return undefined;

  const facts = factsOf(err);

  const statuses = [...facts.statuses];
  for (const pattern of STATUS_PATTERNS) {
    const match = facts.text.match(pattern);
    if (match) statuses.push(Number(match[1]));
  }
  // The first status found anywhere decides, including deciding "no":
  // the API gave an answer, and the answer is what it is.
  for (const status of statuses) {
    if (status >= 100 && status < 600) return retryableStatus(status);
  }

  if (REQUEST_REFUSALS.some((pattern) => pattern.test(facts.text))) return undefined;

  for (const code of facts.codes) {
    const reason = RETRYABLE_CODES.get(code.toUpperCase());
    if (reason !== undefined) return reason;
  }

  for (const [pattern, reason] of TRANSPORT_PHRASES) {
    if (pattern.test(facts.text)) return reason;
  }

  return undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function label(call: ModelCall): string {
  return call === "ask" ? "The clarifying model call" : "The model call";
}

/** The honest failure both calls failing produces, in one place so the
 * clarifying step and a worker's own call word it identically. Names the
 * model, the first failure's kind, and the second failure's own words -
 * and says plainly that nothing was swapped underneath, since a reader
 * of a failed task's record should not have to wonder whether some other
 * model quietly got a turn. */
export function doubleFailureMessage(opts: {
  call: ModelCall;
  model: string;
  firstReason: string;
  secondError: string;
}): string {
  return (
    `${label(opts.call)} failed twice, so this task stopped. ` +
    `The first call failed on a transport error (${opts.firstReason}) and was retried once on the same model, ${opts.model}; ` +
    `the retry failed too: ${opts.secondError}. ` +
    `Fabrica retries a dropped model call once and never switches to another model on its own - ` +
    `a switch is a decision with a record behind it, not something that happens quietly here.`
  );
}

/**
 * Runs `call`, retrying it exactly once if it fails the way a dropped
 * connection fails. Anything else - including the second failure -
 * propagates, so a request-level refusal still reaches the Client
 * unchanged and at once.
 *
 * Deliberately not a counted loop with a configurable number: this is
 * one reconnect, not an attempt budget. The budget is
 * `src/foreman/attempts.ts`' own loop (CONTRACT rule 3), which this runs
 * inside of and never adds to.
 */
export async function withTransportRetry<T>(
  call: () => Promise<T>,
  opts: {
    which: ModelCall;
    /** Named in the failure when both calls fail, and on the event. */
    model: string;
    /** Appends the "transport-retry" event. Called once, before the
     * wait, so the record says a retry is coming rather than reporting
     * it only once it has already happened. */
    onRetry: (details: TransportRetryDetails) => void;
    /** Asked immediately before the retry is decided on: true means the
     * caller already knows this call is not worth making again - today,
     * an attempt whose worker Fabrica itself just stopped (issue #189's
     * pause rule). The original error then propagates, unretried. */
    giveUp?: () => boolean;
    waitMs?: number;
    /** Test seam - lets a test prove the wait happened without waiting
     * it out. */
    wait?: (ms: number) => Promise<void>;
  }
): Promise<T> {
  const waitMs = opts.waitMs ?? TRANSPORT_RETRY_WAIT_MS;
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let firstReason: string;
  try {
    return await call();
  } catch (err) {
    const reason = transportFailureReason(err);
    // Not a transport failure: an honest answer, reported as it is.
    if (reason === undefined) throw err;
    if (opts.giveUp?.()) throw err;
    firstReason = reason;
    opts.onRetry({
      call: opts.which,
      reason,
      error: messageOf(err),
      model: opts.model,
      waitMs,
    });
  }

  await wait(waitMs);

  try {
    return await call();
  } catch (err) {
    throw new ForemanError(
      "model-call-failed",
      doubleFailureMessage({ call: opts.which, model: opts.model, firstReason, secondError: messageOf(err) })
    );
  }
}
