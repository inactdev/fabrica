import { test } from "node:test";
import assert from "node:assert/strict";
import { gateNamesIn, mergeGateDeclarations } from "./gate-declarations.ts";

test("gateNamesIn finds the gates a declaration names, however they are spelled", () => {
  assert.deepEqual(gateNamesIn("check.sh: added a step so the new test runs."), ["check.sh"]);
  assert.deepEqual(gateNamesIn("Reworded contract/rule9.gate-is-sacred.test.ts, nothing else."), [
    "contract/rule9.gate-is-sacred.test.ts",
  ]);
  assert.deepEqual(gateNamesIn("Edited .github/workflows/rule9-gate.yml and CONTRACT.md."), [
    ".github/workflows/rule9-gate.yml",
    "contract.md",
  ]);
  assert.deepEqual(gateNamesIn("Check.sh and check.sh are the same file"), ["check.sh"]);
});

test("gateNamesIn leaves ordinary prose alone", () => {
  // A one-character extension ("e.g."), a version number, a bare
  // sentence: none of these is a gate, and reading one as a gate would
  // keep a stale declaration alive next to a newer one.
  assert.deepEqual(gateNamesIn("Nothing changed, e.g. no test was touched, i.e. the gate is untouched."), []);
  assert.deepEqual(gateNamesIn("Bumped the pinned toolchain from 1.2.3 to 1.3.0."), []);
  assert.deepEqual(gateNamesIn("No gate change. None at all."), []);
});

test("mergeGateDeclarations keeps the newest declaration per gate", () => {
  const merged = mergeGateDeclarations([
    "check.sh: added a step so the new test runs.",
    "check.sh: added a step so the new test runs, and dropped the stale one.",
  ]);
  assert.equal(merged, "check.sh: added a step so the new test runs, and dropped the stale one.");
});

test("mergeGateDeclarations keeps declarations about different gates side by side", () => {
  const merged = mergeGateDeclarations([
    "check.sh: added a step.",
    undefined,
    "contract/rule9.gate-is-sacred.test.ts: reworded one assertion.",
  ]);
  assert.equal(merged, "check.sh: added a step.\n\ncontract/rule9.gate-is-sacred.test.ts: reworded one assertion.");
});

test("mergeGateDeclarations does not grow across rounds that declare the same gate again", () => {
  const rounds = Array.from({ length: 20 }, (_, i) => `check.sh: pass ${i + 1} of the same edit.`);
  const merged = mergeGateDeclarations(rounds)!;

  assert.equal(merged, "check.sh: pass 20 of the same edit.");
  assert.equal(merged.split("\n\n").length, 1, "one block per gate, however many rounds declared it");
});

test("mergeGateDeclarations: a declaration naming several gates stands for all of them, as one block", () => {
  const merged = mergeGateDeclarations([
    "check.sh: added a step.",
    "contract/rule9.gate-is-sacred.test.ts: reworded one assertion.",
    "check.sh and contract/rule9.gate-is-sacred.test.ts: both reverted to what they were.",
  ]);
  assert.equal(merged, "check.sh and contract/rule9.gate-is-sacred.test.ts: both reverted to what they were.");
});

test("mergeGateDeclarations: a declaration naming no gate at all is kept, newest only", () => {
  assert.equal(mergeGateDeclarations(["loosened the cap", "loosened the cap further"]), "loosened the cap further");
});

test("mergeGateDeclarations: nothing declared is undefined, which a delivery renders as the empty string", () => {
  assert.equal(mergeGateDeclarations([]), undefined);
  assert.equal(mergeGateDeclarations([undefined, "", "   "]), undefined);
});

test("mergeGateDeclarations: one declaration comes back exactly as the worker wrote it", () => {
  const declared = "check.sh: swapped `npm test` for `npm run ci`, because the suite moved.";
  assert.equal(mergeGateDeclarations([declared]), declared);
});
