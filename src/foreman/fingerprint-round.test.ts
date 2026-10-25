// The fingerprint as the record actually carries it, end to end: a real
// task, a real ProductionLine, real git. What is being proved here is
// not how a patch id is computed (`fingerprint.test.ts` does that) but
// that every attempt's receipt and every pass's delivery ends up
// stamped, and that a later pass says plainly whether the change is the
// one the task was already checked at.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "./foreman.ts";
import { deliveryOf, eventsOf, passFingerprintsOf, priorPassFingerprints, receiptsOf } from "./queries.ts";
import { readTaskFile } from "../record/index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { fixtureInspector } from "../../contract/helpers/fake-inspector.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-fingerprint-round-"));
}

/** A worker that writes whatever the next call is meant to write - the
 * same content twice means a round that changes nothing. */
function brainWriting(contents: string[]) {
  let call = 0;
  return fakeBrain({
    onWork: (_brief, workdir) => {
      writeFileSync(join(workdir, "work.txt"), contents[Math.min(call++, contents.length - 1)]);
    },
  });
}

test("a first delivery is stamped, and has nothing to compare itself against", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });
  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain: brainWriting(["v1\n"]) });

  const delivery = deliveryOf(recordHome, task.id);
  assert.ok(delivery?.fingerprint?.patchId, "the delivery carries this pass's change fingerprint");
  assert.equal(delivery?.fingerprint?.baseBranch, "master", "and names the branch it was measured against");
  assert.equal(delivery?.fingerprintMatch, undefined, "a first pass has no earlier pass to compare with");

  const receipts = receiptsOf(recordHome, task.id);
  assert.equal(receipts.length, 1);
  assert.equal(
    receipts[0].fingerprint?.patchId,
    delivery?.fingerprint?.patchId,
    "the attempt's own receipt carries the same stamp the delivery hands over"
  );

  assert.match(
    readTaskFile(recordHome, task.id, "delivery.md") ?? "",
    /fingerprint: fingerprint [0-9a-f]{7}$/m,
    "delivery.md shows it in the same words every other surface does"
  );
});

test("a fix round that really changes the work voids every earlier observation", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });
  const task = await foreman.do("small change", {
    project: makeFixtureRepo("exit 0"),
    brain: brainWriting(["v1\n", "v2\n"]),
  });
  const first = deliveryOf(recordHome, task.id)?.fingerprint?.patchId;
  assert.ok(first);

  await foreman.verdict(task.id, "fix", "do it differently");

  const delivery = deliveryOf(recordHome, task.id);
  assert.ok(delivery?.fingerprint?.patchId);
  assert.notEqual(delivery?.fingerprint?.patchId, first, "the change moved, so the fingerprint did");
  assert.deepEqual(delivery?.fingerprintMatch, {
    matched: false,
    previous: first,
    previousPass: 1,
    voidsEarlierObservations: true,
  });
});

test("a fix round that leaves the work alone reads as unchanged since the pass before it", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });
  const task = await foreman.do("small change", {
    project: makeFixtureRepo("exit 0"),
    // The same content both times: the worker changes nothing, which is
    // the "nothing-changed" path - stamped like any other outcome.
    brain: brainWriting(["v1\n"]),
  });
  const first = deliveryOf(recordHome, task.id)?.fingerprint?.patchId;
  assert.ok(first);

  await foreman.verdict(task.id, "fix", "have another look");

  const delivery = deliveryOf(recordHome, task.id);
  assert.equal(delivery?.outcome, "nothing-changed");
  assert.equal(delivery?.fingerprint?.patchId, first);
  assert.deepEqual(delivery?.fingerprintMatch, {
    matched: true,
    previous: first,
    previousPass: 1,
    matchedPass: 1,
    voidsEarlierObservations: false,
  });
});

test("a pass that comes back to an earlier change is matched against that earlier pass, by name", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });
  const task = await foreman.do("small change", {
    project: makeFixtureRepo("exit 0"),
    brain: brainWriting(["v1\n", "v2\n", "v1\n"]),
  });

  await foreman.verdict(task.id, "fix", "try the other way");
  await foreman.verdict(task.id, "fix", "no, put it back");

  const delivery = deliveryOf(recordHome, task.id);
  assert.equal(delivery?.fingerprintMatch?.matched, true);
  assert.equal(delivery?.fingerprintMatch?.matchedPass, 1, "back to the change pass 1 carried");
  assert.equal(delivery?.fingerprintMatch?.previousPass, 2, "and still says what pass 2 had");
  assert.equal(
    delivery?.fingerprintMatch?.voidsEarlierObservations,
    false,
    "this change WAS observed before, at pass 1, so nothing is void"
  );
});

test("the record's own pass list counts one pass per round and never compares a round with itself", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });
  const task = await foreman.do("small change", {
    project: makeFixtureRepo("exit 0"),
    brain: brainWriting(["v1\n", "v2\n"]),
  });
  await foreman.verdict(task.id, "fix", "do it differently");

  const events = eventsOf(recordHome, task.id);
  const { passes, count } = passFingerprintsOf(events);
  assert.equal(count, 2, "one pass for the first round, one for the fix round");
  assert.deepEqual(
    passes.map((entry) => entry.pass),
    [1, 2]
  );
  assert.notEqual(passes[0].patchId, passes[1].patchId);
  // Its one caller is always inside the pass it is asking about, so it
  // drops the latest - which is exactly what stops a round being
  // compared with its own stamp.
  assert.deepEqual(priorPassFingerprints(events), [passes[0]]);
});
