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

  const first = await brain.work("brief one", "/workdir");
  const second = await brain.work("brief two", "/workdir");

  assert.notEqual(first.session, second.session);
  assert.deepEqual(brain.historyBySession.get(first.session!), ["brief one"]);
  assert.deepEqual(brain.historyBySession.get(second.session!), ["brief two"]);
});

test("fakeBrain: a retry passing the prior session continues it (warm), never restarts", async () => {
  const brain = fakeBrain();

  const first = await brain.work("initial brief", "/workdir");
  const retry = await brain.work("correction: fix the failing check", "/workdir", {
    session: first.session,
  });

  assert.equal(retry.session, first.session);
  assert.deepEqual(brain.historyBySession.get(first.session!), [
    "initial brief",
    "correction: fix the failing check",
  ]);
  assert.match(retry.transcript, /2 brief\(s\)/);
});

test("fakeBrain: passes brief and workdir through to onWork", async () => {
  const seen: Array<{ brief: string; workdir: string }> = [];
  const brain = fakeBrain({ onWork: (brief, workdir) => seen.push({ brief, workdir }) });

  await brain.work("the brief", "/some/workdir");

  assert.deepEqual(seen, [{ brief: "the brief", workdir: "/some/workdir" }]);
});

test("fakeBrain: gateChanges is omitted by default - the gate is untouched", async () => {
  const brain = fakeBrain();

  const result = await brain.work("brief", "/workdir");

  assert.equal(result.gateChanges, undefined);
  assert.equal("gateChanges" in result, false);
});

test("fakeBrain: gateChanges is carried through faithfully when configured", async () => {
  const brain = fakeBrain({ gateChanges: "loosened contract/rule2.check.test.ts because X" });

  const result = await brain.work("brief", "/workdir");

  assert.equal(result.gateChanges, "loosened contract/rule2.check.test.ts because X");
});

test("fakeBrain: name and model identify it as the fake, matching the Brain shape", () => {
  const brain = fakeBrain();

  assert.equal(brain.name, "fake");
  assert.equal(brain.model, "fake-1");
});
