// Issue #199: a transport failure is retried once, on the same model,
// and recorded; a request-level refusal is not retried at all; a model
// that stays down stops the task with a failure naming it.
//
// The two end-to-end tests at the bottom are the issue's own "done
// when": a fake adapter that drops the first call succeeds on the retry
// with one event, and one that drops both produces a failed task naming
// the error. They pay the real TRANSPORT_RETRY_WAIT_MS on purpose - the
// whole point of those two is the whole path, defaults included, and a
// wait nobody waits is a wait nobody is proving.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doTask } from "./do.ts";
import { ForemanError } from "./errors.ts";
import { receiptsOf, stateOf } from "./queries.ts";
import { TRANSPORT_RETRY_WAIT_MS, transportFailureReason, withTransportRetry } from "./transport-retry.ts";
import type { TransportRetryDetails } from "./transport-retry.ts";
import { readEventsForTask } from "../record/index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { fixtureCheckBox } from "../../contract/helpers/fake-check-box.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-transport-retry-home-"));
}

/** The wrapper, with the wait replaced so a test never sits out five
 * real seconds - and the waits it was asked for, so the wait itself is
 * still proven rather than skipped. */
function retried<T>(
  call: () => Promise<T>,
  opts: { giveUp?: () => boolean; model?: string; which?: "work" | "ask" } = {}
): { run: () => Promise<T>; retries: TransportRetryDetails[]; waits: number[] } {
  const retries: TransportRetryDetails[] = [];
  const waits: number[] = [];
  return {
    retries,
    waits,
    run: () =>
      withTransportRetry(call, {
        which: opts.which ?? "work",
        model: opts.model ?? "a-model",
        onRetry: (details) => retries.push(details),
        ...(opts.giveUp ? { giveUp: opts.giveUp } : {}),
        wait: async (ms) => {
          waits.push(ms);
        },
      }),
  };
}

// --- what counts as a transport failure, and what deliberately doesn't -------

// The exact sentence two tasks were lost to (#139, #168) - the one case
// this whole mechanism exists for.
test("a connection closed mid-response is a transport failure", () => {
  assert.match(transportFailureReason(new Error("Connection closed mid-response")) ?? "", /closed mid-response/);
});

test("the shapes a dropped call arrives in are all transport failures", () => {
  const cases: [unknown, RegExp][] = [
    [new Error("socket hang up"), /closed mid-response/],
    [Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }), /reset/],
    [Object.assign(new Error("fetch failed"), { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) }), /reset/],
    [Object.assign(new Error("request failed"), { code: "ETIMEDOUT" }), /timed out/],
    [new Error("no response within 600000ms"), /timed out/],
    [new Error("the model API answered 503: upstream unavailable"), /answered 503/],
    // 529 ("overloaded") is covered by every 5xx being covered, with no
    // provider's own spelling of it named anywhere.
    [new Error("API Error: 529 {\"type\":\"overloaded_error\"}"), /answered 529/],
    [new Error("rate limited (api_error_status 429)"), /429/],
    [Object.assign(new Error("too many requests"), { status: 429 }), /429/],
  ];
  for (const [err, expected] of cases) {
    const reason = transportFailureReason(err);
    assert.match(reason ?? "<not a transport failure>", expected, `${(err as Error).message} was not classified`);
  }
});

// The other half of the Client's ruling: the API answered, and the
// answer is the answer. Retrying any of these spends money to be told
// the same thing twice.
test("a request-level refusal is never a transport failure", () => {
  const refusals: unknown[] = [
    new Error("Invalid API key · Fix external (api_error_status 401)"),
    new Error("the model API answered 403: forbidden"),
    new Error("the model API answered 400: invalid_request_error"),
    new Error("prompt is too long: 250000 tokens > 200000 maximum"),
    new Error("context_length_exceeded"),
    new Error("exit code 1"),
    new Error("the worker produced no result line"),
  ];
  for (const err of refusals) {
    assert.equal(transportFailureReason(err), undefined, `${(err as Error).message} should not be retried`);
  }
});

// A status the API really answered with decides on its own - so a
// refusal whose body text happens to mention a connection or a timeout
// is still an answer, not a dropped call.
test("a refusal that mentions a connection is still a refusal", () => {
  assert.equal(
    transportFailureReason(new Error("the model API answered 401: your connection closed the session, authenticate again")),
    undefined
  );
});

// Fabrica's own refusals (a dead relay, a cap, a failed commit) are
// never a model call that did not arrive.
test("a ForemanError is never a transport failure", () => {
  const relayGone = new ForemanError(
    "worker-network-gone",
    'the task\'s network relay (container "x") is no longer running, so every request from the worker box is refused: timed out'
  );
  assert.equal(transportFailureReason(relayGone), undefined);
});

// --- the one retry ----------------------------------------------------------

test("a dropped call is made once more, after a wait, and reported once", async () => {
  let calls = 0;
  const { run, retries, waits } = retried(async () => {
    calls += 1;
    if (calls === 1) throw new Error("Connection closed mid-response");
    return "the answer";
  });

  assert.equal(await run(), "the answer");
  assert.equal(calls, 2, "the call was not retried");
  assert.deepEqual(waits, [TRANSPORT_RETRY_WAIT_MS], "the retry did not wait first");
  assert.equal(retries.length, 1);
  assert.equal(retries[0].call, "work");
  assert.equal(retries[0].model, "a-model");
  assert.match(retries[0].reason, /closed mid-response/);
  assert.equal(retries[0].error, "Connection closed mid-response", "the brain's own words are kept verbatim");
});

test("a request-level refusal is reported at once, unretried and unchanged", async () => {
  let calls = 0;
  const refusal = new Error("the model API answered 401: invalid api key");
  const { run, retries, waits } = retried(async () => {
    calls += 1;
    throw refusal;
  });

  await assert.rejects(run, (err) => err === refusal);
  assert.equal(calls, 1);
  assert.deepEqual(retries, []);
  assert.deepEqual(waits, []);
});

test("both calls failing stops with a failure naming the model, both errors, and no swap", async () => {
  const { run, retries } = retried(
    async () => {
      throw new Error("Connection closed mid-response");
    },
    { model: "model-under-test" }
  );

  await assert.rejects(run, (err: unknown) => {
    assert.ok(err instanceof ForemanError);
    assert.equal(err.code, "model-call-failed");
    assert.match(err.message, /model-under-test/);
    assert.match(err.message, /Connection closed mid-response/);
    assert.match(err.message, /never switches to another model/);
    return true;
  });
  assert.equal(retries.length, 1, "the retry is still on the record even though it failed too");
});

// The retry answers the question "did it arrive?", not "was it right?" -
// a second failure of any kind ends the task, and says what it was.
test("a retry that fails for a different reason is reported with that reason", async () => {
  let calls = 0;
  const { run } = retried(async () => {
    calls += 1;
    if (calls === 1) throw new Error("socket hang up");
    throw new Error("the model API answered 401: invalid api key");
  });

  await assert.rejects(run, /invalid api key/);
});

// Issue #189: the worker was stopped by Fabrica itself a moment ago.
// The call ending is that stop arriving, not a dropped connection.
test("a caller that has already given up on the call is not retried", async () => {
  let calls = 0;
  const dropped = new Error("Connection closed mid-response");
  const { run, retries } = retried(
    async () => {
      calls += 1;
      throw dropped;
    },
    { giveUp: () => true }
  );

  await assert.rejects(run, (err) => err === dropped);
  assert.equal(calls, 1);
  assert.deepEqual(retries, []);
});

// --- the issue's own "done when", end to end --------------------------------

test("a brain that drops the first call delivers on the retry, with one event and no extra attempt", async () => {
  const project = makeFixtureRepo("exit 0", { inspector: false });
  const recordHome = freshHome();
  const brain = fakeBrain({
    workError: (call) => (call === 1 ? new Error("Connection closed mid-response") : undefined),
    onWork: (_brief, workdir) => writeFileSync(join(workdir, "feature.txt"), "work\n"),
  });

  const task = await doTask(recordHome, "small change", { project, brain, checkBox: fixtureCheckBox().box });

  assert.equal(task.state, "delivered");
  const events = readEventsForTask(recordHome, task.id);
  const retries = events.filter((e) => e.name === "transport-retry");
  assert.equal(retries.length, 1, "one dropped call, one event");
  const details = retries[0].details as TransportRetryDetails;
  assert.equal(details.call, "work");
  assert.equal(details.attempt, 1);
  assert.equal(details.model, "fake-1", "the retry went back to the same model");
  assert.match(details.reason, /closed mid-response/);

  // Rule 3 counts attempts, not reconnects: the retry happened inside
  // attempt 1 and left the loop's own numbers alone.
  const receipts = receiptsOf(recordHome, task.id);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].attempt, 1);
  assert.equal(receipts[0].outcome, "delivered");
});

test("a brain that drops both calls fails the task, naming the model and the error", async () => {
  const project = makeFixtureRepo("exit 0", { inspector: false });
  const recordHome = freshHome();
  const brain = fakeBrain({ workError: new Error("Connection closed mid-response") });
  // `doTask` throws here, so the task id arrives through this rather
  // than through its return value.
  let taskId = "";

  await assert.rejects(
    () =>
      doTask(recordHome, "small change", {
        project,
        brain,
        checkBox: fixtureCheckBox().box,
        onTaskRegistered: (id) => (taskId = id),
      }),
    (err: unknown) => err instanceof ForemanError && err.code === "model-call-failed"
  );

  const events = readEventsForTask(recordHome, taskId);
  assert.equal(stateOf(events), "failed");
  assert.equal(events.filter((e) => e.name === "transport-retry").length, 1);
  const failed = events.find((e) => e.name === "task-failed")?.details as { message?: string } | undefined;
  assert.match(failed?.message ?? "", /Connection closed mid-response/, "the record does not name the error");
  assert.match(failed?.message ?? "", /fake-1/, "the record does not name the model");
  // A call that never came back is not an attempt, so it leaves no
  // receipt - and no second model was tried behind the Client's back.
  assert.equal(receiptsOf(recordHome, taskId).length, 0);
});
