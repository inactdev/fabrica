// Issue #68: what one round writes about itself, and what a reader
// reconstructs from the whole record. The duplication these tests exist
// to prevent is only visible across several fix rounds, so the first one
// actually runs six.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "./foreman.ts";
import { deliveryOf, eventsOf, receiptsOf } from "./queries.ts";
import type { DeliveredDetails } from "./queries.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { fixtureInspector } from "../../contract/helpers/fake-inspector.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-round-home-"));
}

/** A worker that lands a genuinely new commit on every call, so each fix
 * round delivers its own round rather than short-circuiting on
 * "nothing changed". */
function workingBrain(gateChanges?: (call: number) => string | undefined) {
  let version = 0;
  return fakeBrain({
    onWork: (_brief, workdir) => writeFileSync(join(workdir, "work.txt"), `v${++version}\n`),
    ...(gateChanges ? { gateChanges } : {}),
  });
}

function deliveredDetails(recordHome: string, taskId: string): DeliveredDetails[] {
  return eventsOf(recordHome, taskId)
    .filter((event) => event.name === "delivered")
    .map((event) => event.details as DeliveredDetails);
}

test("each round's delivered event stores that round's receipts alone, however many rounds there are", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });
  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain: workingBrain() });

  const FIX_ROUNDS = 5;
  for (let round = 1; round <= FIX_ROUNDS; round += 1) {
    await foreman.verdict(task.id, "fix", `round ${round}: a little more`);
  }

  const delivered = deliveredDetails(recordHome, task.id);
  assert.equal(delivered.length, FIX_ROUNDS + 1, "one delivery per round");

  // Each event carries only its own round's attempt...
  assert.deepEqual(
    delivered.map((details) => details.receipts?.map((receipt) => receipt.attempt)),
    [[1], [2], [3], [4], [5], [6]]
  );
  // ...so the record holds one stored receipt per attempt, not one per
  // attempt per round that came after it. Six rounds used to store
  // 1+2+3+4+5+6 = 21 of them, and the growth was the square of the round
  // count - which `src/record/read.ts` then parsed for every query.
  const stored = delivered.reduce((count, details) => count + (details.receipts?.length ?? 0), 0);
  assert.equal(stored, FIX_ROUNDS + 1);

  // The one cumulative fact a single event cannot reconstruct is a number
  // now, not a re-stored list.
  assert.deepEqual(
    delivered.map((details) => details.attemptsSoFar),
    [1, 2, 3, 4, 5, 6]
  );
});

test("the cumulative view every caller already had is reconstructed on read, unchanged", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });
  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain: workingBrain() });
  for (let round = 1; round <= 3; round += 1) await foreman.verdict(task.id, "fix", `round ${round}`);

  assert.deepEqual(
    receiptsOf(recordHome, task.id).map((receipt) => receipt.attempt),
    [1, 2, 3, 4]
  );
  // Every attempt appears exactly once, with its own check attached -
  // the cumulative list was never a different list, only a stored one.
  assert.deepEqual(
    receiptsOf(recordHome, task.id).map((receipt) => receipt.checks?.green),
    [true, true, true, true]
  );
  assert.equal(
    (await foreman.receiptsOf(task.id)).length,
    4,
    "the public Foreman.receiptsOf seam answers the same way"
  );
});

test("a later round's attempt numbering continues from the reconstructed view, never restarts", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });
  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain: workingBrain() });
  await foreman.verdict(task.id, "fix", "once more");
  await foreman.verdict(task.id, "fix", "and again");

  const delivered = deliveredDetails(recordHome, task.id);
  assert.deepEqual(delivered.at(-1)?.receipts?.map((receipt) => receipt.attempt), [3]);
  assert.equal(delivered.at(-1)?.attemptsSoFar, 3);
});

test("a gate declared again in a later round is reported in that round's words, once", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });
  const brain = workingBrain((call) => `check.sh: added step ${call}, so the new test runs.`);
  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain });
  for (let round = 1; round <= 3; round += 1) await foreman.verdict(task.id, "fix", `round ${round}`);

  // Four rounds declared the same gate, each in slightly different
  // words. The latest round's intent is the one that stands (Client
  // ruling, issue #68) - the delivery does not stack all four.
  assert.equal(deliveryOf(recordHome, task.id)?.gateChanges, "check.sh: added step 4, so the new test runs.");
  // Each round's own words are still on the record, untouched.
  assert.deepEqual(
    deliveredDetails(recordHome, task.id).map((details) => details.gateDeclarations),
    [
      ["check.sh: added step 1, so the new test runs."],
      ["check.sh: added step 2, so the new test runs."],
      ["check.sh: added step 3, so the new test runs."],
      ["check.sh: added step 4, so the new test runs."],
    ]
  );
});

test("a gate an earlier round declared and a later one left alone is still reported", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });
  // Round 1 touches check.sh; round 2 touches a ratified test and says
  // nothing about check.sh; round 3 declares nothing at all. The
  // delivery reports the whole cumulative diff, so it has to account for
  // both gates.
  const brain = workingBrain((call) =>
    call === 1
      ? "check.sh: added a step so the new test runs."
      : call === 2
        ? "contract/rule9.gate-is-sacred.test.ts: repointed one import."
        : undefined
  );
  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain });
  await foreman.verdict(task.id, "fix", "the ratified test needs repointing");
  await foreman.verdict(task.id, "fix", "nothing to declare this time");

  assert.equal(
    deliveryOf(recordHome, task.id)?.gateChanges,
    "check.sh: added a step so the new test runs.\n\n" +
      "contract/rule9.gate-is-sacred.test.ts: repointed one import."
  );
});

test("a delivery's evidence points at the receipt that holds the check output", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });
  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain: workingBrain() });
  await foreman.verdict(task.id, "fix", "once more");

  const delivery = deliveryOf(recordHome, task.id)!;
  assert.match(delivery.evidence, /attempt 2's receipt/, "the second round's own attempt, not the first's");
  const receipt = receiptsOf(recordHome, task.id).find((r) => r.attempt === 2);
  assert.ok(receipt?.checks?.output, "the receipt the delivery points at really does hold the output");
});
