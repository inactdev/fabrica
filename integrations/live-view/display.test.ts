import { test } from "node:test";
import assert from "node:assert/strict";
import { isScrolledToBottom, rowEmphasis, stateSymbol } from "./display.ts";
import type { DisplayState } from "./record-view.ts";

const ALL_DISPLAY_STATES: DisplayState[] = [
  "working",
  "asked a question",
  "delivered",
  "failed",
  "stopped",
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
});

test("isScrolledToBottom: true at or within the threshold of the bottom, false well above it", () => {
  assert.equal(isScrolledToBottom(996, 1000, 4), true, "exactly at the bottom");
  assert.equal(isScrolledToBottom(1000, 1000, 4), true, "scrollTop beyond scrollHeight-clientHeight still counts as bottom");
  assert.equal(isScrolledToBottom(993, 1000, 4), true, "within the default threshold");
  assert.equal(isScrolledToBottom(500, 1000, 4), false, "scrolled well up from the bottom");
  assert.equal(isScrolledToBottom(0, 1000, 1000), true, "content that fits entirely on screen is always 'at the bottom'");
});
