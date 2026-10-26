import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDeclines, readerCorrection, READER_DECLINES_FILE } from "./correction.ts";

const FINDINGS = [
  { file: "src/a.ts", finding: "the error is swallowed" },
  { file: "src/b.ts", finding: "the empty case is never handled" },
];

test("the correction hands every finding over, numbered, and names the declines file", () => {
  const text = readerCorrection(FINDINGS);

  assert.match(text, /1\. src\/a\.ts: the error is swallowed/);
  assert.match(text, /2\. src\/b\.ts: the empty case is never handled/);
  assert.match(text, new RegExp(READER_DECLINES_FILE.replace(/\./g, "\\.")));
  assert.match(text, /"declines"/);
});

test("the correction says the reader is not a gate, so nothing reads as an order", () => {
  const text = readerCorrection(FINDINGS);
  assert.match(text, /not a gate/);
  assert.match(text, /cannot approve/);
  assert.match(text, /not orders/);
});

test("the correction tells the worker to keep what already passed", () => {
  assert.match(readerCorrection(FINDINGS), /keep everything that was already right/i);
});

test("one finding reads as one finding, not as '1 of them'", () => {
  assert.match(readerCorrection([FINDINGS[0]]), /Work through all of it/);
  assert.match(readerCorrection(FINDINGS), /Work through all 2 of them/);
});

test("no declines file means the worker acted on every finding", () => {
  assert.deepEqual(parseDeclines(undefined, 2), { declines: [] });
  assert.deepEqual(parseDeclines("   \n", 2), { declines: [] });
});

test("a decline comes back with the number the brief used", () => {
  const parsed = parseDeclines('{"declines":[{"finding":2,"reason":"that case cannot happen here"}]}', 2);
  assert.deepEqual(parsed.declines, [{ finding: 2, reason: "that case cannot happen here" }]);
  assert.equal(parsed.problem, undefined);
});

test("a declines file that will not parse is reported, not thrown", () => {
  const parsed = parseDeclines("not json at all", 2);
  assert.deepEqual(parsed.declines, []);
  assert.match(parsed.problem ?? "", /not valid JSON/);
});

test("a declines file with no declines array is reported", () => {
  const parsed = parseDeclines('{"notes":"I disagree"}', 2);
  assert.deepEqual(parsed.declines, []);
  assert.match(parsed.problem ?? "", /no "declines" array/);
});

test("a decline naming a finding out of range is dropped and reported", () => {
  const parsed = parseDeclines('{"declines":[{"finding":7,"reason":"no"},{"finding":1,"reason":"fine as is"}]}', 2);
  assert.deepEqual(parsed.declines, [{ finding: 1, reason: "fine as is" }]);
  assert.match(parsed.problem ?? "", /1 of the worker's declines/);
  assert.match(parsed.problem ?? "", /range 1-2/);
});

test("a decline with no reason is dropped: declining silently is not an option", () => {
  const parsed = parseDeclines('{"declines":[{"finding":1,"reason":"  "}]}', 2);
  assert.deepEqual(parsed.declines, []);
  assert.match(parsed.problem ?? "", /gave\s+no reason/);
});
