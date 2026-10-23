# One retry on a transport failure, never a silent downgrade (issue #199)

## The plan, and the alternative rejected before starting

**The shape chosen.** The retry sits around the one thing Fabrica itself
calls - a `Brain` method - and nowhere else: `brain.work()` inside
`runAttempts` (`src/foreman/attempts.ts`) and `brain.ask()` inside
`registerAndAsk` (`src/foreman/ask.ts`). Classification of "is this a
transport failure" is its own module, `src/foreman/transport-retry.ts`,
with an **allowlist** of recognized transport shapes: anything it does
not recognize fails immediately and honestly, which is the project's
standing "everything fails loudly" ruling applied to a classifier that
cannot be sure.

Safest first: an allowlist can only ever cost a task one honest failure
it might in principle have survived, while a denylist (retry unless it
looks like a refusal) silently re-runs a whole worker - real money, real
time, possibly duplicate work - on every error shape nobody anticipated.
Most accurate second: the classifier reads the two real adapters' own
error wording (`src/brain/adapters/claude-code.ts`'s
`"<detail> (api_error_status <n>)"`, the OpenAI-compatible agent's
`"the model API answered <n>: ..."`), not an invented shape. Fastest
last: the retry waits a few seconds rather than returning instantly,
because the failures it covers - an overloaded provider, a rate limit -
are exactly the ones an instant retry makes worse.

**The alternative rejected: retrying inside the adapter.**
`src/brain/adapters/openai-agent/client.mjs` already retries 429/5xx on
its own HTTP call, inside the worker's box, so the obvious cheap move was
to leave this to each adapter. Rejected for two reasons. It cannot be
recorded: the box has no path to the record, so a retry there is exactly
the silent, unrecorded behaviour issue #199 exists to stop. And it is not
a rule - every future adapter would have to re-implement it, and a brain
that did not would lose tasks the way #139 and #168 did, with nothing on
Fabrica's side noticing. The Foreman owns counting (CONTRACT rule 3's
spirit: counting is ordinary code in the Foreman, never a model's
decision), so it owns this count too.

## What was built

- `src/foreman/transport-retry.ts` - `transportFailureReason(err)` (the
  classifier) and `withTransportRetry(call, opts)` (one retry, a short
  wait, then an honest `ForemanError("model-call-failed")` naming the
  model and the error).
- `"transport-retry"` joins `src/inspector/types.ts`'s local widening of
  `FabricaEventName` - **not** `contract/surface.ts`, for the same reason
  `"meter-refused"`/`"stopped-by-owner"` live there: the contract is a
  path `rule9-gate.yml` protects, and a reconnect Fabrica made is its own
  bookkeeping, not a new promise to the Client about a seam.
- The retry is never an attempt. It happens *inside* one attempt of
  `runAttempts`' counted loop, so rule 3's number is untouched: three
  still means three attempts, however many reconnects happened inside
  them.

## Every place with the same shape

All three model calls Fabrica makes now go through one wrapper - the
worker's `brain.work()` (`attempts.ts`), the clarifying `brain.ask()`
(`ask.ts`), and the quiz re-check's own `brain.work()`
(`src/quiz/recheck.ts`, the one model call outside a production round).
A fourth call site added later belongs inside it too; that is the rule,
not a per-site decision.

Same shape, deliberately **left standing** (a transient failure losing
work, but not a model call, so outside issue #199):

- `src/brain/adapters/openai-agent/client.mjs` already retries
  408/409/429/5xx and connect failures twice, *inside* the worker's box.
  It cannot record anything - the box has no path to the record - so its
  retries stay invisible. Harmless overlap: that one covers the box's own
  HTTP call, this one covers the call Fabrica makes to the box.
- `src/github/fetch-issue.ts` and `src/ci/` make GitHub API reads with
  no retry at all. A blip there refuses a task before it starts, or
  reads a pull request's checks as unknown.
- `src/inspector/run.ts` spawns Inspector once, with no retry.

## Sharp edges worth keeping

- **The retry is wrapped by the heartbeat, not the other way round.**
  `withTransportRetry` is the function `withHeartbeat` runs, so the
  heartbeat keeps ticking through the wait and the second call - a
  retrying task never reads as "quiet" - and `withHeartbeat`'s own
  relay-health probe still rejects the whole thing if the box's network
  died. That ordering also means `ForemanError("worker-network-gone")` is
  raised *outside* the wrapper and can never be retried, which is
  deliberate: a dead relay does not come back in five seconds, and it
  already has its own honest report.
- **`liveEntries` must be cleared on a retry.** `runAttempts` delivers
  each attempt's trailing transcript entries as
  `work.transcript.slice(liveEntries.length)`, which is only correct
  while `liveEntries` is a prefix of *that* call's transcript. A dropped
  call's live entries stay delivered (they really happened, and they are
  in `transcript.log`), but the array is reset the moment a retry is
  decided, or the retry's own transcript would be silently truncated by
  however many entries the dropped call managed.
- **A refused connection is not retried, on purpose.** The clarification
  named connection-closed and connect/read timeouts, 5xx (529 included)
  and 429. `ECONNREFUSED` is none of those, and in this codebase it is
  the shape a dead per-task relay produces - already covered by
  `worker-network-gone`'s immediate, honest failure.
