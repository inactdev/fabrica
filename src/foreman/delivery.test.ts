import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDelivery, buildCommitFailureDelivery } from "./delivery.ts";
import { MAX_RECEIPT_CHECK_OUTPUT_BYTES } from "./attempts.ts";

const HEAD_MARKER = "FIRST-LINE-OF-CHECK-OUTPUT";
const TAIL_MARKER = "LAST-LINE-OF-CHECK-OUTPUT";

/** A red check that printed far more than the record may store. */
function noisyRedGate() {
  const filler = `${"x".repeat(79)}\n`.repeat(4000);
  return { green: false, output: `${HEAD_MARKER}\n${filler}${TAIL_MARKER}\n` };
}

function assertTruncatedLikeAReceipt(evidence: string) {
  assert.match(evidence, /\[truncated, showing last \d+ of \d+ bytes\]\n/);
  assert.ok(
    Buffer.byteLength(evidence, "utf8") < MAX_RECEIPT_CHECK_OUTPUT_BYTES + 400,
    `evidence was ${Buffer.byteLength(evidence, "utf8")} bytes`
  );
  assert.ok(evidence.includes(TAIL_MARKER), "the end of the output - where a check says what failed - is kept");
  assert.ok(!evidence.includes(HEAD_MARKER), "the beginning is what gets dropped");
}

test("a delivery's evidence stores only the tail of a long check output, behind a truncation marker", () => {
  const delivery = buildDelivery("failure-report", {
    taskText: "do the thing",
    attempts: 1,
    lastGate: noisyRedGate(),
    branch: "fabrica/task-1",
    files: ["a.ts"],
    declaredGateChanges: undefined,
  });

  assertTruncatedLikeAReceipt(delivery.evidence);
});

test("a commit-failure delivery's evidence is truncated the same way", () => {
  const delivery = buildCommitFailureDelivery({
    attempts: 1,
    lastGate: noisyRedGate(),
    branch: "fabrica/task-1",
    declaredGateChanges: undefined,
    error: "index.lock exists",
  });

  assertTruncatedLikeAReceipt(delivery.evidence);
  assert.ok(delivery.evidence.startsWith("Last check: "));
});

test("a check output within the cap is stored in evidence exactly as it ran", () => {
  const output = "./check.sh -> exit 0\nall good\n";

  const delivery = buildDelivery("done", {
    taskText: "do the thing",
    attempts: 1,
    lastGate: { green: true, output },
    branch: "fabrica/task-1",
    files: ["a.ts"],
    declaredGateChanges: undefined,
  });

  assert.equal(delivery.evidence, output);
});

// Issue #68, Client ruling: the receipt is the source for a check's
// output, and the delivery points at it rather than storing the same
// text a second time - with the first and last few lines so the report
// still reads on its own.

/** The gate output a check of N lines produced. */
function gateOfLines(lines: number) {
  return { green: false, output: Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n") + "\n" };
}

test("evidence names the receipt that holds the output in full", () => {
  const delivery = buildDelivery("failure-report", {
    taskText: "do the thing",
    attempts: 3,
    lastGate: gateOfLines(4),
    evidenceAttempt: 3,
    branch: "fabrica/task-1",
    files: ["a.ts"],
    declaredGateChanges: undefined,
  });

  assert.match(delivery.evidence, /attempt 3's receipt in this task's record/);
  // Short enough to show whole: the pointer is still there, because the
  // receipt is the source either way.
  assert.match(delivery.evidence, /line 1\nline 2\nline 3\nline 4$/);
});

test("evidence shows the first and last lines of a long output, saying what it is not showing", () => {
  const delivery = buildDelivery("failure-report", {
    taskText: "do the thing",
    attempts: 1,
    lastGate: gateOfLines(100),
    evidenceAttempt: 1,
    branch: "fabrica/task-1",
    files: ["a.ts"],
    declaredGateChanges: undefined,
  });

  assert.match(delivery.evidence, /attempt 1's receipt/);
  assert.match(delivery.evidence, /^line 1$/m, "the head is kept");
  assert.match(delivery.evidence, /^line 100$/m, "and the tail, where a check says what failed");
  assert.match(delivery.evidence, /\[\.\.\. 80 line\(s\) not shown here - the receipt has them \.\.\.\]/);
  assert.doesNotMatch(delivery.evidence, /^line 50$/m, "the middle is what the receipt is for");
  // Bounded by lines now, not only by bytes.
  assert.equal(delivery.evidence.split("\n").filter((l) => /^line \d+$/.test(l)).length, 20);
});

test("a delivery whose round named no receipt stores the output as it always did", () => {
  // Never less than before: a caller that cannot say which attempt holds
  // the output must not point the Client at a receipt that may not be
  // there.
  const delivery = buildDelivery("failure-report", {
    taskText: "do the thing",
    attempts: 1,
    lastGate: gateOfLines(100),
    branch: "fabrica/task-1",
    files: ["a.ts"],
    declaredGateChanges: undefined,
  });

  assert.equal(delivery.evidence, gateOfLines(100).output);
  assert.doesNotMatch(delivery.evidence, /receipt/);
});

test("a round that reached no verdict says so, rather than pointing at a receipt", () => {
  const delivery = buildDelivery("failure-report", {
    taskText: "do the thing",
    attempts: 1,
    lastGate: undefined,
    evidenceAttempt: undefined,
    branch: "fabrica/task-1",
    files: ["a.ts"],
    declaredGateChanges: undefined,
  });

  assert.equal(delivery.evidence, "No check reached a verdict.");
});
