import { test } from "node:test";
import assert from "node:assert/strict";
import {
  configProblemNotice,
  isScrolledToBottom,
  meterFill,
  noteToSend,
  projectName,
  rowEmphasis,
  stalenessNotice,
  stateSymbol,
} from "./display.ts";
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

test("noteToSend: an empty note box sends no note at all, exactly as `fabrica verdict` with no -m (Client ruling)", () => {
  assert.equal(noteToSend(""), undefined);
  // Whitespace-only is empty too - a stray space a thumb left behind is
  // not the Client's reaction to anything.
  assert.equal(noteToSend("   "), undefined);
  assert.equal(noteToSend("\n\t "), undefined);
});

test("noteToSend: real text is sent trimmed, the same note `fabrica verdict -m` would record", () => {
  assert.equal(noteToSend("ship it"), "ship it");
  assert.equal(noteToSend("  ship it  "), "ship it");
  // Only the ends are trimmed - the Client's own wording, including any
  // punctuation and inner spacing, reaches the record verbatim.
  assert.equal(noteToSend("\nthe button is on the wrong side.  twice.\n"), "the button is on the wrong side.  twice.");
});

// The staleness rule has to agree, exactly, with the one
// src/cli/up-command.ts's refreshStaleLiveView applies before stopping a
// live view: stale only when both commits are known strings and they
// differ. A page claiming stale about a live view `fabrica up` would
// happily reuse (or the reverse) is worse than no banner at all.
test("stalenessNotice: two different known commits is stale, and the banner names both and the fix", () => {
  const notice = stalenessNotice("aaaaaaaaaaaabbbb", "ccccccccccccdddd");
  assert.ok(notice, "a server running different code from the checkout must say so");
  // Both commits, at doctor's own 12-character display width.
  assert.match(notice, /aaaaaaaaaaaa/);
  assert.match(notice, /cccccccccccc/);
  assert.doesNotMatch(notice, /aaaaaaaaaaaabbbb/, "the full sha is longer than this banner needs");
  assert.match(notice, /fabrica update/, "a banner the reader can't act on is just noise");
});

test("stalenessNotice: the same commit on both sides says nothing", () => {
  assert.equal(stalenessNotice("abc123abc123", "abc123abc123"), null);
});

// A null on either side means the comparison cannot be made at all - an
// installed copy with no recorded commit, a git lookup that failed, a
// request that never landed. Saying "stale" there would teach the Client
// to ignore the one banner that matters.
test("stalenessNotice: an unknown commit on either side says nothing rather than guessing", () => {
  assert.equal(stalenessNotice(null, "abc123abc123"), null);
  assert.equal(stalenessNotice("abc123abc123", null), null);
  assert.equal(stalenessNotice(null, null), null);
});

// The message already carries the file's path and the line the parser
// stopped on (src/config/load.ts) - this only labels it, so there is
// exactly one author of the wording a reader acts on.
test("configProblemNotice: a real problem is shown verbatim, with the consequence named", () => {
  const notice = configProblemNotice({ message: "/home/me/.fabrica/projects.toml:3:1: not valid TOML - bad key" });
  assert.ok(notice);
  assert.match(notice, /\/home\/me\/\.fabrica\/projects\.toml:3:1: not valid TOML - bad key/);
  assert.match(notice, /caps and projects are unknown/);
});

test("configProblemNotice: no problem, or an empty one, says nothing", () => {
  assert.equal(configProblemNotice(null), null);
  assert.equal(configProblemNotice(undefined), null);
  assert.equal(configProblemNotice({}), null);
  assert.equal(configProblemNotice({ message: "   " }), null);
});
