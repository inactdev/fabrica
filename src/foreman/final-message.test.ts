import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeMissingFinalMessage,
  FINAL_MESSAGE_TITLE_MAX_LENGTH,
  lastFinalMessageText,
  parseFinalMessage,
  renderFinalMessageBody,
} from "./final-message.ts";

const WELL_FORMED =
  "Add retry on login timeout\n\n" +
  "What:\nRetries the login call once on timeout.\n\n" +
  "Why:\nUsers were seeing spurious failures.\n\n" +
  "How:\nWrapped the call in a single retry.\n\n" +
  "Deviations:\nNone.";

// Negative first: a message with no title line at all - the worker wrote
// straight into the sections with nothing to use as a title.
test("parseFinalMessage refuses a message with no title line", () => {
  const result = parseFinalMessage("What:\na\n\nWhy:\nb\n\nHow:\nc\n\nDeviations:\nNone.");

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.ok(result.missing.includes("a title line"));
});

test("parseFinalMessage refuses a title line longer than 60 characters", () => {
  const longTitle = "x".repeat(FINAL_MESSAGE_TITLE_MAX_LENGTH + 1);
  const result = parseFinalMessage(`${longTitle}\n\nWhat:\na\n\nWhy:\nb\n\nHow:\nc\n\nDeviations:\nNone.`);

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.ok(result.missing.some((m) => m.includes("60 characters")));
});

test("parseFinalMessage refuses a message missing the Deviations section", () => {
  const result = parseFinalMessage("A fine title\n\nWhat:\na\n\nWhy:\nb\n\nHow:\nc");

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.deepEqual(result.missing, ['a "Deviations" section']);
});

test("parseFinalMessage names every missing section at once, not just the first", () => {
  const result = parseFinalMessage("A fine title\n\nWhat:\na");

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.deepEqual(result.missing, ['a "Why" section', 'a "How" section', 'a "Deviations" section']);
});

test("parseFinalMessage accepts a well-formed message and extracts every section, title included", () => {
  const result = parseFinalMessage(WELL_FORMED);

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.message.title, "Add retry on login timeout");
  assert.equal(result.message.sections.What, "Retries the login call once on timeout.");
  assert.equal(result.message.sections.Why, "Users were seeing spurious failures.");
  assert.equal(result.message.sections.How, "Wrapped the call in a single retry.");
  assert.equal(result.message.sections.Deviations, "None.");
});

test("parseFinalMessage tolerates leading blank lines before the title", () => {
  const result = parseFinalMessage(`\n\n${WELL_FORMED}`);

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.message.title, "Add retry on login timeout");
});

test("renderFinalMessageBody renders the four sections in the ratified order, Deviations last", () => {
  const result = parseFinalMessage(WELL_FORMED);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");

  assert.equal(
    renderFinalMessageBody(result.message),
    "What:\nRetries the login call once on timeout.\n\n" +
      "Why:\nUsers were seeing spurious failures.\n\n" +
      "How:\nWrapped the call in a single retry.\n\n" +
      "Deviations:\nNone."
  );
});

test("lastFinalMessageText reads the last text-kind transcript entry, skipping other kinds after it", () => {
  const transcript = [
    { occurredAt: "t1", kind: "text", text: "first" },
    { occurredAt: "t2", kind: "tool-call", text: "ignored" },
    { occurredAt: "t3", kind: "text", text: "final" },
    { occurredAt: "t4", kind: "usage", text: '{"totalCostUsd":0.1}' },
  ];

  assert.equal(lastFinalMessageText(transcript), "final");
});

test("lastFinalMessageText returns undefined for a transcript with no text entry at all", () => {
  assert.equal(lastFinalMessageText([{ occurredAt: "t1", kind: "usage", text: "{}" }]), undefined);
  assert.equal(lastFinalMessageText([]), undefined);
});

test("describeMissingFinalMessage names every missing piece in one sentence", () => {
  assert.equal(
    describeMissingFinalMessage(["a title line", 'a "Deviations" section']),
    `the worker's final message is missing a title line, a "Deviations" section`
  );
});
