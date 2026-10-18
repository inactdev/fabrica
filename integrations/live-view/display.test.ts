import { test } from "node:test";
import assert from "node:assert/strict";
import { isScrolledToBottom, meterFill, projectName, rowEmphasis, stateSymbol } from "./display.ts";
import type { DisplayState } from "./record-view.ts";

const ALL_DISPLAY_STATES: DisplayState[] = [
  "working",
  "asked a question",
  "delivered",
  "failed",
  "stopped",
  "stopped by you",
  "closed (accept)",
  "closed (wrong)",
  "closed",
];

test("stateSymbol: every displayed state gets its own symbol - a glyph, or (working alone) a CSS-only spinner class", () => {
  for (const state of ALL_DISPLAY_STATES) {
    const symbol = stateSymbol(state);
    assert.ok(symbol.cls.length > 0, `${state} has no symbol class`);
    if (state === "working") {
      assert.equal(symbol.text, "", "working's spinner is CSS-drawn, not a text glyph");
    } else {
      assert.ok(symbol.text.length > 0, `${state} has no symbol glyph`);
    }
  }
});

test("stateSymbol: the specific glyphs the Client asked for", () => {
  assert.equal(stateSymbol("delivered").text, "✓");
  assert.equal(stateSymbol("asked a question").text, "?");
  assert.equal(stateSymbol("failed").text, "✗");
  assert.equal(stateSymbol("stopped").cls, "symbol-dot");
  // Issue #203: the Client's own stop is the one outcome here he
  // caused, so it is a square rather than another gray dot.
  assert.equal(stateSymbol("stopped by you").text, "■");
  assert.equal(stateSymbol("stopped by you").cls, "symbol-stopped");
  assert.equal(stateSymbol("closed (accept)").cls, "symbol-dot");
  assert.equal(stateSymbol("closed (wrong)").cls, "symbol-dot");
  assert.equal(stateSymbol("closed").cls, "symbol-dot");
  assert.equal(stateSymbol("working").cls, "symbol-spin");
});

test("rowEmphasis: failed and asked-a-question stand out, closed rows fade, everything else is plain", () => {
  assert.equal(rowEmphasis("failed"), "emphasis");
  assert.equal(rowEmphasis("asked a question"), "emphasis");
  assert.equal(rowEmphasis("closed (accept)"), "fade");
  assert.equal(rowEmphasis("closed (wrong)"), "fade");
  assert.equal(rowEmphasis("closed"), "fade");
  assert.equal(rowEmphasis("working"), "normal");
  assert.equal(rowEmphasis("delivered"), "normal");
  assert.equal(rowEmphasis("stopped"), "normal");
  assert.equal(rowEmphasis("stopped by you"), "fade");
});

test("isScrolledToBottom: true at or within the threshold of the bottom, false well above it", () => {
  assert.equal(isScrolledToBottom(996, 1000, 4), true, "exactly at the bottom");
  assert.equal(isScrolledToBottom(1000, 1000, 4), true, "scrollTop beyond scrollHeight-clientHeight still counts as bottom");
  assert.equal(isScrolledToBottom(993, 1000, 4), true, "within the default threshold");
  assert.equal(isScrolledToBottom(500, 1000, 4), false, "scrolled well up from the bottom");
  assert.equal(isScrolledToBottom(0, 1000, 1000), true, "content that fits entirely on screen is always 'at the bottom'");
});

test("projectName: the folder name alone, whatever separators or trailing slashes the path has", () => {
  assert.equal(projectName("/home/me/code/fabrica"), "fabrica");
  assert.equal(projectName("/home/me/code/fabrica/"), "fabrica");
  assert.equal(projectName("/home/me/code/fabrica///"), "fabrica");
  assert.equal(projectName("fabrica"), "fabrica");
  // A path that is nothing but separators has no name in it at all -
  // the em dash, never a blank cell.
  assert.equal(projectName("/"), "—");
  assert.equal(projectName(null), "—");
  assert.equal(projectName(""), "—");
});

test("meterFill: no cap means no meter at all - the cost stands as plain text (Client ruling)", () => {
  assert.equal(meterFill(1.5, undefined), null);
  assert.equal(meterFill(1.5, 0), null, "a zero cap has no fraction to show");
  assert.equal(meterFill(1.5, -1), null);
});

test("meterFill: the fraction of the cap spent, clamped at both ends, with its own colour past 80% and at 100%", () => {
  assert.deepEqual(meterFill(0, 4), { fraction: 0, level: "" });
  assert.deepEqual(meterFill(1, 4), { fraction: 0.25, level: "" });
  assert.deepEqual(meterFill(3.2, 4), { fraction: 0.8, level: "high" });
  assert.deepEqual(meterFill(4, 4), { fraction: 1, level: "full" });
  // Past the cap the bar is full, never overflowing its own track.
  assert.deepEqual(meterFill(9, 4), { fraction: 1, level: "full" });
  // Defensive: a negative figure can't exist on a receipt, but it must
  // not produce a negative width if one ever did.
  assert.deepEqual(meterFill(-1, 4), { fraction: 0, level: "" });
});
