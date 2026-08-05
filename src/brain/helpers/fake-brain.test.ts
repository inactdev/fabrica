import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeBrain } from "./fake-brain.ts";

test("fakeBrain: counts every call to work()", async () => {
  const brain = fakeBrain();

  await brain.work("do the thing", "/workdir");
  await brain.work("do another thing", "/workdir");

  assert.equal(brain.calls, 2);
});

test("fakeBrain: a call with no session starts a fresh one each time (cold)", async () => {
  const brain = fakeBrain();

  const first = await brain.work("instructions one", "/workdir");
  const second = await brain.work("instructions two", "/workdir");

  assert.notEqual(first.session, second.session);
  assert.deepEqual(brain.historyBySession.get(first.session!), ["instructions one"]);
  assert.deepEqual(brain.historyBySession.get(second.session!), ["instructions two"]);
});

test("fakeBrain: a retry passing the prior session continues it (warm), never restarts", async () => {
  const brain = fakeBrain();

  const first = await brain.work("initial instructions", "/workdir");
  const retry = await brain.work("correction: fix the failing check", "/workdir", {
    session: first.session,
  });

  assert.equal(retry.session, first.session);
  assert.deepEqual(brain.historyBySession.get(first.session!), [
    "initial instructions",
    "correction: fix the failing check",
  ]);
  assert.match(retry.transcript, /2 instruction\(s\)/);
});

test("fakeBrain: passes instructions and workdir through to onWork", async () => {
  const seen: Array<{ instructions: string; workdir: string }> = [];
  const brain = fakeBrain({
    onWork: (instructions, workdir) => seen.push({ instructions, workdir }),
  });

  await brain.work("the instructions", "/some/workdir");

  assert.deepEqual(seen, [{ instructions: "the instructions", workdir: "/some/workdir" }]);
});

test("fakeBrain: gateChanges is omitted by default - the gate is untouched", async () => {
  const brain = fakeBrain();

  const result = await brain.work("instructions", "/workdir");

  assert.equal(result.gateChanges, undefined);
  assert.equal("gateChanges" in result, false);
});

test("fakeBrain: gateChanges is carried through faithfully when configured", async () => {
  const brain = fakeBrain({ gateChanges: "loosened contract/rule2.check.test.ts because X" });

  const result = await brain.work("instructions", "/workdir");

  assert.equal(result.gateChanges, "loosened contract/rule2.check.test.ts because X");
});

test("fakeBrain: name and model identify it as the fake, matching the Brain shape", () => {
  const brain = fakeBrain();

  assert.equal(brain.name, "fake");
  assert.equal(brain.model, "fake-1");
});

test("fakeBrain: an effort value it does not recognize is ignored, not a failure", async () => {
  const brain = fakeBrain();

  await assert.doesNotReject(
    brain.work("instructions", "/workdir", { effort: "ludicrous-speed" })
  );
});

test("fakeBrain: the requested effort is recorded even though the fake ignores it", async () => {
  const brain = fakeBrain();

  await brain.work("instructions one", "/workdir", { effort: "high" });
  await brain.work("instructions two", "/workdir");

  assert.deepEqual(brain.effortsRequested, ["high", undefined]);
});

test("fakeBrain: effort is passed through to onWork alongside instructions and workdir", async () => {
  const seen: Array<string | undefined> = [];
  const brain = fakeBrain({ onWork: (_instructions, _workdir, effort) => seen.push(effort) });

  await brain.work("instructions", "/workdir", { effort: "low" });

  assert.deepEqual(seen, ["low"]);
});
