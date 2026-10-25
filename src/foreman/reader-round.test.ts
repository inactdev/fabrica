// Inspector issue #34 and its amendment, exercised through a real round:
// a real ProductionLine, a real Inspector handoff (faked), a real worker
// pass. Only the model call itself is replaced, through `doTask`'s
// `readDiff` seam - so nothing here needs a credential or a network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doTask } from "./do.ts";
import { deliveryOf, receiptsOf } from "./queries.ts";
import { recordVerdict } from "./verdict.ts";
import { readEventsForTask } from "../record/index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { fakeInspector, fixtureInspector } from "../../contract/helpers/fake-inspector.ts";
import { fixtureCheckBox } from "../../contract/helpers/fake-check-box.ts";
import { READER_DECLINES_FILE } from "../reader/index.ts";
import type { ReaderFinding, ReaderReport, ResolvedReader } from "../reader/index.ts";
import { addReaderToHome, TEST_READER_MODEL, TEST_READER_VENDOR } from "../reader/helpers/configured-home.ts";
import type { DiffReader } from "./reader-round.ts";

const READER_LABEL = `${TEST_READER_VENDOR}/${TEST_READER_MODEL}`;

function freshHome(): string {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-reader-round-"));
  addReaderToHome(recordHome);
  return recordHome;
}

/** A fake read. Records the diff it was handed, so a test can prove the
 * whole patch really went over rather than a file list. */
function reads(findings: ReaderFinding[]) {
  const diffs: string[] = [];
  const read: DiffReader = async (reader: ResolvedReader, diff: string): Promise<ReaderReport> => {
    diffs.push(diff);
    return { model: `${reader.vendor}/${reader.model}`, findings, diffBytes: Buffer.byteLength(diff, "utf8") };
  };
  return { read, diffs };
}

function failingRead(message: string): DiffReader {
  return async () => {
    throw new Error(message);
  };
}

const FINDING: ReaderFinding = { file: "feature.txt", finding: "the empty case is never handled" };

function names(recordHome: string, taskId: string): string[] {
  return readEventsForTask(recordHome, taskId).map((event) => event.name);
}

test("a clean read lands on the record, runs no fix pass, and the delivery says so", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();
  const brain = fakeBrain({ onWork: (_brief, workdir) => writeFileSync(join(workdir, "feature.txt"), "work\n") });
  const { read, diffs } = reads([]);

  const task = await doTask(recordHome, "small change", {
    project,
    brain,
    inspector: fixtureInspector(),
    readDiff: read,
  });

  assert.equal(task.state, "delivered");
  assert.ok(names(recordHome, task.id).includes("reader-clean"));
  assert.ok(!names(recordHome, task.id).includes("reader-flagged"));
  // One worker call only: a clean read means no fix round at all.
  assert.equal(brain.calls, 1);
  assert.equal(receiptsOf(recordHome, task.id).length, 1);

  const delivery = deliveryOf(recordHome, task.id);
  assert.equal(delivery!.outcome, "done");
  assert.deepEqual(delivery!.reader, { model: READER_LABEL, state: "clean", findings: [] });

  // The whole diff, not a file list: the patch the reader was handed
  // carries git's own headers and the added line itself.
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /diff --git/);
  assert.match(diffs[0], /\+work/);
});

test("a flagged read hands the findings back to the same worker as one more pass, then delivers", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();
  const briefs: string[] = [];
  const brain = fakeBrain({
    onWork: (brief, workdir) => {
      briefs.push(brief);
      writeFileSync(join(workdir, briefs.length === 1 ? "feature.txt" : "fix.txt"), "work\n");
    },
  });

  const task = await doTask(recordHome, "small change", {
    project,
    brain,
    inspector: fixtureInspector(),
    readDiff: reads([FINDING]).read,
  });

  assert.equal(task.state, "delivered");
  const recorded = names(recordHome, task.id);
  assert.ok(recorded.includes("reader-flagged"));
  // The read falls between the first pass's own Inspector verdict and
  // the delivery - "before delivery", as the amendment asks.
  assert.ok(recorded.lastIndexOf("reader-flagged") < recorded.lastIndexOf("delivered"));

  // Two worker calls: the round's own, then the reader's fix pass.
  assert.equal(brain.calls, 2);
  assert.match(briefs[1], /code reader/);
  assert.match(briefs[1], /1\. feature\.txt: the empty case is never handled/);
  // The same machine, resumed - not a cold worker rediscovering the
  // branch. fakeBrain reports its session, and runAttempts passes it on.
  assert.match(briefs[1], /small change/, "the fix pass lost the task's own words");

  // Inspector judged the fix pass too, so the delivery's green is a
  // green on the code the reader's findings were acted on.
  const delivery = deliveryOf(recordHome, task.id);
  assert.equal(delivery!.outcome, "done");
  assert.equal(delivery!.reader?.state, "flagged");
  assert.deepEqual(delivery!.reader?.findings, [FINDING]);
  // The fix pass's work is on the branch.
  assert.ok(delivery!.files.includes("fix.txt"), `the fix pass's file is missing: ${delivery!.files.join(", ")}`);
});

test("the read happens once per task - a later fix round is never read again", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();
  let pass = 0;
  const brain = fakeBrain({
    onWork: (_brief, workdir) => writeFileSync(join(workdir, `pass-${++pass}.txt`), "work\n"),
  });
  const { read, diffs } = reads([]);

  const task = await doTask(recordHome, "small change", {
    project,
    brain,
    inspector: fixtureInspector(),
    readDiff: read,
  });
  assert.equal(diffs.length, 1);

  // The Client asks for a change. That round goes green again - and is
  // NOT read a second time (clarification 2: the post-fix pass delivers
  // straight after Inspector's green).
  await recordVerdict(recordHome, task.id, "fix", "also handle the other case", {
    brain,
    inspector: fixtureInspector(),
    readDiff: read,
  });

  assert.equal(diffs.length, 1, "the task was read a second time");
  assert.equal(names(recordHome, task.id).filter((name) => name === "reader-clean").length, 1);
});

test("a task that first turns green in a fix round is read there, not skipped", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();
  // A different file each pass: the fix round's judge is wrapped with
  // `skipIfUnchanged`, so a worker that rewrites identical bytes is
  // never judged at all and would never reach a green to read.
  let pass = 0;
  const brain = fakeBrain({
    onWork: (_brief, workdir) => writeFileSync(join(workdir, `pass-${++pass}.txt`), "work\n"),
  });
  const { read, diffs } = reads([]);

  // Red first, so this round reaches no read at all.
  const task = await doTask(recordHome, "small change", {
    project,
    brain,
    attempts: 1,
    inspector: fakeInspector("red"),
    readDiff: read,
  });
  assert.equal(diffs.length, 0, "a red round must not be read");
  assert.ok(!names(recordHome, task.id).some((name) => name.startsWith("reader-")));

  // The Client's fix turns it green - and that is where the one read
  // falls due.
  await recordVerdict(recordHome, task.id, "fix", "make it pass", {
    brain,
    inspector: fakeInspector("green"),
    readDiff: read,
  });

  assert.equal(diffs.length, 1);
  assert.ok(names(recordHome, task.id).includes("reader-clean"));
});

test("a declined finding is recorded beside it, with the worker's reason", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();
  let pass = 0;
  const brain = fakeBrain({
    onWork: (_brief, workdir) => {
      pass++;
      if (pass === 1) {
        writeFileSync(join(workdir, "feature.txt"), "work\n");
        return;
      }
      // The worker disagrees with the one finding, and says why - plus
      // an unrelated change, so the pass is not an "unchanged" one.
      writeFileSync(join(workdir, "notes.txt"), "considered\n");
      writeFileSync(
        join(workdir, READER_DECLINES_FILE),
        JSON.stringify({ declines: [{ finding: 1, reason: "that case cannot occur here" }] })
      );
    },
  });

  const task = await doTask(recordHome, "small change", {
    project,
    brain,
    inspector: fixtureInspector(),
    readDiff: reads([FINDING]).read,
  });

  const delivery = deliveryOf(recordHome, task.id);
  assert.deepEqual(delivery!.reader?.findings, [{ ...FINDING, declined: "that case cannot occur here" }]);
  // And the delivery's own rendering shows the reason under the finding.
  const rendered = readFileSync(join(recordHome, "tasks", task.id, "delivery.md"), "utf8");
  assert.match(rendered, /declined by the worker: that case cannot occur here/);
});

// The sharp edge: this worktree IS committed, unlike the scratch
// checkout src/quiz/recheck.ts reads its own result file out of.
test("the worker's declines file never reaches the branch", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();
  let pass = 0;
  const brain = fakeBrain({
    onWork: (_brief, workdir) => {
      pass++;
      if (pass === 1) {
        writeFileSync(join(workdir, "feature.txt"), "work\n");
        return;
      }
      writeFileSync(join(workdir, "fix.txt"), "fixed\n");
      writeFileSync(
        join(workdir, READER_DECLINES_FILE),
        JSON.stringify({ declines: [{ finding: 1, reason: "partly disagree" }] })
      );
    },
  });

  const task = await doTask(recordHome, "small change", {
    project,
    brain,
    inspector: fixtureInspector(),
    readDiff: reads([FINDING]).read,
  });

  const delivery = deliveryOf(recordHome, task.id);
  assert.ok(
    !delivery!.files.includes(READER_DECLINES_FILE),
    `the declines file was committed: ${delivery!.files.join(", ")}`
  );
  // Still read, though - the decline is on the delivery.
  assert.equal(delivery!.reader?.findings[0].declined, "partly disagree");
});

test("a fix pass whose worker changes nothing keeps the already-green delivery", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();
  let pass = 0;
  const brain = fakeBrain({
    onWork: (_brief, workdir) => {
      pass++;
      if (pass === 1) writeFileSync(join(workdir, "feature.txt"), "work\n");
      else {
        // Declines everything and changes nothing else.
        writeFileSync(
          join(workdir, READER_DECLINES_FILE),
          JSON.stringify({ declines: [{ finding: 1, reason: "the finding is wrong" }] })
        );
      }
    },
  });

  const task = await doTask(recordHome, "small change", {
    project,
    brain,
    inspector: fixtureInspector(),
    readDiff: reads([FINDING]).read,
  });

  // The green stands - never "nothing-changed", and never a refusal from
  // re-handing an identical commit to Inspector.
  assert.equal(task.state, "delivered");
  const delivery = deliveryOf(recordHome, task.id);
  assert.equal(delivery!.outcome, "done");
  assert.equal(delivery!.reader?.findings[0].declined, "the finding is wrong");
  // The pass's money is still counted: two receipts, two worker calls.
  assert.equal(brain.calls, 2);
  assert.equal(receiptsOf(recordHome, task.id).length, 2);
});

test("a failed read never blocks the delivery, and is never silent", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();
  const brain = fakeBrain({ onWork: (_brief, workdir) => writeFileSync(join(workdir, "feature.txt"), "work\n") });

  const task = await doTask(recordHome, "small change", {
    project,
    brain,
    inspector: fixtureInspector(),
    readDiff: failingRead("the reader's model answered 503: upstream is down"),
  });

  // Delivered, green, as if the reader had never been asked.
  assert.equal(task.state, "delivered");
  const delivery = deliveryOf(recordHome, task.id);
  assert.equal(delivery!.outcome, "done");
  assert.equal(brain.calls, 1, "a failed read must not start a fix pass");

  // And loudly: on the record, and on the delivery.
  assert.ok(names(recordHome, task.id).includes("reader-failed"));
  assert.equal(delivery!.reader?.state, "failed");
  assert.match(delivery!.reader?.error ?? "", /503/);
});

test("no reader configured is a recorded failure, not a silent skip", async () => {
  const project = makeFixtureRepo("exit 0");
  // Deliberately not freshHome(): no [reader] anywhere.
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-reader-round-"));
  const brain = fakeBrain({ onWork: (_brief, workdir) => writeFileSync(join(workdir, "feature.txt"), "work\n") });

  const task = await doTask(recordHome, "small change", { project, brain, inspector: fixtureInspector() });

  assert.equal(task.state, "delivered");
  const delivery = deliveryOf(recordHome, task.id);
  assert.equal(delivery!.outcome, "done");
  assert.equal(delivery!.reader?.state, "failed");
  assert.equal(delivery!.reader?.model, "none configured");
  // One line, not the several paragraphs `fabrica do` prints - this
  // string becomes a status row and a delivery field.
  assert.equal((delivery!.reader?.error ?? "").split("\n").length, 1);
  assert.match(delivery!.reader?.error ?? "", /no code reader is configured/);
  assert.match(delivery!.reader?.error ?? "", /fabrica do/);
});

test("a self-tested task reaches no read at all - there is no Inspector green to follow", async () => {
  const project = makeFixtureRepo("exit 0", { inspector: false });
  const recordHome = freshHome();
  const brain = fakeBrain({ onWork: (_brief, workdir) => writeFileSync(join(workdir, "feature.txt"), "work\n") });
  const { read, diffs } = reads([FINDING]);

  const task = await doTask(recordHome, "small change", {
    project,
    brain,
    checkBox: fixtureCheckBox().box,
    readDiff: read,
  });

  assert.equal(diffs.length, 0);
  assert.ok(!names(recordHome, task.id).some((name) => name.startsWith("reader-")));
  assert.equal(deliveryOf(recordHome, task.id)!.reader, undefined);
});

test("the declines file is cleaned up even when it cannot be parsed, and the problem is reported", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();
  let pass = 0;
  const brain = fakeBrain({
    onWork: (_brief, workdir) => {
      pass++;
      if (pass === 1) writeFileSync(join(workdir, "feature.txt"), "work\n");
      else {
        writeFileSync(join(workdir, "fix.txt"), "fixed\n");
        writeFileSync(join(workdir, READER_DECLINES_FILE), "not json");
      }
    },
  });

  const task = await doTask(recordHome, "small change", {
    project,
    brain,
    inspector: fixtureInspector(),
    readDiff: reads([FINDING]).read,
  });

  const delivery = deliveryOf(recordHome, task.id);
  assert.equal(delivery!.outcome, "done", "a fumbled declines file must not fail the round");
  assert.match(delivery!.reader?.note ?? "", /not valid JSON/);
  assert.ok(!delivery!.files.includes(READER_DECLINES_FILE));
  assert.equal(existsSync(join(project, READER_DECLINES_FILE)), false);
});
