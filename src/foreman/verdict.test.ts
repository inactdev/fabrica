import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "./foreman.ts";
import { ForemanError } from "./errors.ts";
import { deliveryOf, fixRoundOf, receiptsOf } from "./queries.ts";
import { recordVerdict } from "./verdict.ts";
import { readTaskFile } from "../record/index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-verdict-home-"));
}

/** Exactly what makeFixtureRepo("exit 0") commits as check.sh. */
const PRISTINE_CHECK = "#!/bin/sh\nexit 0\n";

/** A worker that rewrites the gate without declaring it, and does some
 * real work alongside it - rule 9's discarded-protected-path case. */
function tamperingBrain() {
  return fakeBrain({
    onWork: (_brief, workdir) => {
      writeFileSync(join(workdir, "check.sh"), "#!/bin/sh\n# quietly rewritten\nexit 0\n");
      writeFileSync(join(workdir, "feature.txt"), "possibly good work\n");
    },
  });
}

test("accept closes the task and leaves the delivery untouched", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome });
  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain: fakeBrain() });

  await foreman.verdict(task.id, "accept", "looks right");

  const mine = (await foreman.status()).find((t) => t.id === task.id);
  assert.equal(mine?.state, "closed");
  assert.equal((await foreman.receiptsOf(task.id)).length, 1, "accept records no extra attempt");
});

test("wrong closes the task plainly, as a real outcome, not a hidden failure", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome });
  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain: fakeBrain() });

  await foreman.verdict(task.id, "wrong", "not what I asked for");

  const mine = (await foreman.status()).find((t) => t.id === task.id);
  assert.equal(mine?.state, "closed");
  const events = (await foreman.events(task.id)).map((e) => e.name);
  assert.deepEqual(events.filter((n) => n === "verdict-recorded"), ["verdict-recorded"]);
});

test("fix re-enters the same warm worker session on the same line", async () => {
  const recordHome = freshHome();
  const brain = fakeBrain();
  const foreman = createForeman({ recordHome });
  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain });

  assert.equal(brain.calls, 1);
  const firstReceipts = receiptsOf(recordHome, task.id);
  const firstSession = firstReceipts[0].session;
  assert.ok(firstSession);

  await foreman.verdict(task.id, "fix", "wrong button spot");

  assert.equal(brain.calls, 2, "fix ran exactly one more worker call");
  const sessions = [...brain.historyBySession.keys()];
  assert.deepEqual(sessions, [firstSession], "fix continued the same session, it did not start a new one");
  assert.deepEqual(brain.historyBySession.get(firstSession!), [
    "small change",
    `small change\n\n---\n\nThe Client reviewed your previous delivery and asked for a change. ` +
      `Keep everything that was already right, and fix exactly this:\n\nwrong button spot`,
  ]);

  const mine = (await foreman.status()).find((t) => t.id === task.id);
  assert.equal(mine?.state, "delivered", "a fix round leaves the task open, delivered again, not closed");

  const receipts = receiptsOf(recordHome, task.id);
  assert.equal(receipts.length, 2, "the fix round's receipt is appended to the original, not replacing it");
  assert.equal(receipts[1].attempt, 2, "attempt numbering continues instead of restarting at 1");

  const delivery = deliveryOf(recordHome, task.id);
  assert.equal(delivery?.outcome, "done");
});

test("fix draws from no budget of its own - the Client can rule it any number of times (issue #65)", async () => {
  const recordHome = freshHome();
  const brain = fakeBrain();
  const foreman = createForeman({ recordHome });
  // Default budget is 2 attempts; a green first attempt stops early (1
  // used), leaving exactly 1 attempt in do()'s own budget - which used
  // to cap fix at exactly one round. A third round here proves there is
  // no ceiling any more: the Client, not the machine's budget, decides
  // when to stop.
  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain });
  assert.equal(fixRoundOf(recordHome, task.id), 0, "no fix ruled yet");

  await foreman.verdict(task.id, "fix", "one more pass");
  assert.equal(brain.calls, 2, "first fix round ran");
  assert.equal(fixRoundOf(recordHome, task.id), 1);

  await foreman.verdict(task.id, "fix", "another pass, please");
  assert.equal(brain.calls, 3, "a second fix round ran past what the old budget would have allowed");
  assert.equal(fixRoundOf(recordHome, task.id), 2);

  await foreman.verdict(task.id, "fix", "and one more still");
  assert.equal(brain.calls, 4, "a third fix round ran too - no ceiling, no refusal");
  assert.equal(fixRoundOf(recordHome, task.id), 3, "each round is counted and reported, unlimited");

  const mine = (await foreman.status()).find((t) => t.id === task.id);
  assert.equal(mine?.state, "delivered", "still open after three fix rounds");
});

test("a verdict on an already-closed task refuses", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome });
  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain: fakeBrain() });
  await foreman.verdict(task.id, "accept", "good");

  await assert.rejects(
    () => foreman.verdict(task.id, "wrong", "actually no"),
    (err: unknown) => err instanceof ForemanError && err.code === "already-closed"
  );
});

test("a verdict before delivery refuses", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome });

  // No task-received or delivered event at all for this id.
  await assert.rejects(
    () => foreman.verdict("no-such-task", "accept"),
    (err: unknown) => err instanceof ForemanError && err.code === "unknown-task"
  );
});

test("fix without a note refuses, naming the note as what's missing", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome });
  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain: fakeBrain() });

  await assert.rejects(
    () => foreman.verdict(task.id, "fix"),
    (err: unknown) => err instanceof ForemanError && err.code === "missing-note"
  );
});

test("an unrecognized ruling refuses rather than silently doing nothing", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome });
  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain: fakeBrain() });

  const verdict = foreman.verdict as (taskId: string, ruling: string, note?: string) => Promise<void>;
  await assert.rejects(
    () => verdict(task.id, "maybe", "note"),
    (err: unknown) => err instanceof ForemanError && err.code === "invalid-verdict"
  );
});

test("a fix round measures rule 9 against the task's pristine base, not what the last round left on the branch", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  const foreman = createForeman({ recordHome });

  const task = await foreman.do("small change", { project, brain: tamperingBrain() });
  assert.equal(deliveryOf(recordHome, task.id)?.outcome, "discarded-protected-path");

  // The fix round's worker never touches check.sh - but the tampered one
  // round 1 committed is still on the branch, so the delivery must still
  // say so rather than reporting a clean "done" over it.
  const innocent = fakeBrain({
    onWork: (_brief, workdir) => writeFileSync(join(workdir, "more.txt"), "the correction\n"),
  });
  await recordVerdict(recordHome, task.id, "fix", "also add more.txt", { brain: innocent });

  const delivery = deliveryOf(recordHome, task.id);
  assert.equal(
    delivery?.outcome,
    "discarded-protected-path",
    "an undeclared gate change carried over from round 1 must not read as clean in round 2"
  );
  assert.equal(receiptsOf(recordHome, task.id).at(-1)?.outcome, "discarded-protected-path");
});

test("a fix round that puts the gate back the way it was is not flagged for it", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  const foreman = createForeman({ recordHome });

  const task = await foreman.do("small change", { project, brain: tamperingBrain() });
  assert.equal(deliveryOf(recordHome, task.id)?.outcome, "discarded-protected-path");

  const honest = fakeBrain({
    onWork: (_brief, workdir) => writeFileSync(join(workdir, "check.sh"), PRISTINE_CHECK),
  });
  await recordVerdict(recordHome, task.id, "fix", "put check.sh back the way it was", { brain: honest });

  const delivery = deliveryOf(recordHome, task.id);
  assert.equal(delivery?.outcome, "done", "restoring the gate to its base state is not a gate change");
  assert.deepEqual(delivery?.files, ["feature.txt"], "the round's real work still lands on the branch");
});

test("a gate change declared in an earlier round still counts for the fix round that inherits it", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  const foreman = createForeman({ recordHome });

  const declarer = fakeBrain({
    gateChanges: "check.sh now echoes before exiting, as the Client asked",
    onWork: (_brief, workdir) => writeFileSync(join(workdir, "check.sh"), "#!/bin/sh\necho checking\nexit 0\n"),
  });
  const task = await foreman.do("small change", { project, brain: declarer });
  assert.equal(deliveryOf(recordHome, task.id)?.outcome, "done");

  const quiet = fakeBrain({
    onWork: (_brief, workdir) => writeFileSync(join(workdir, "more.txt"), "the correction\n"),
  });
  await recordVerdict(recordHome, task.id, "fix", "also add more.txt", { brain: quiet });

  const delivery = deliveryOf(recordHome, task.id);
  assert.equal(delivery?.outcome, "done", "a declaration made for a change still on the branch travels with it");
  assert.match(delivery?.gateChanges ?? "", /echoes before exiting/);
});

test("a fix still runs after a red do() run already spent both default attempts", async () => {
  const recordHome = freshHome();
  const brain = fakeBrain();
  const foreman = createForeman({ recordHome });
  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 1"), brain });
  assert.equal(brain.calls, 2, "default policy: one attempt, one fix pass on red, both spent already");

  await foreman.verdict(task.id, "fix", "try again");
  assert.equal(brain.calls, 3, "the fix ran despite do()'s own budget being fully spent");
});

test("the human-readable verdict file is written before the closing record event, so a crash between the two never hides what the Client said", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome });
  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain: fakeBrain() });

  // Force the record event write to fail deterministically, without
  // touching production code to add a testability seam: reads of
  // events.jsonl (recordVerdict's own lookups happen first) still work
  // read-only, but appendEvent's open-for-append fails. Stands in for
  // any real crash between the two writes (a full disk, a killed
  // process) - the same principle as do.ts's commit-failure delivery
  // writing delivery.md before its "delivered" event.
  const eventsPath = join(recordHome, "events.jsonl");
  chmodSync(eventsPath, 0o444);

  await assert.rejects(() => foreman.verdict(task.id, "accept", "looks right"));

  const verdictFile = readTaskFile(recordHome, task.id, "verdict");
  assert.ok(verdictFile, "the verdict file must exist even though the closing event never landed");
  assert.match(verdictFile!, /accept: looks right/);
});
