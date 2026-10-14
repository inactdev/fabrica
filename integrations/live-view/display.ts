// Pure, DOM-free presentation rules shared by the list pages (index.html/
// history.html, via public/app.js) and the task page (public/task.js) -
// factored out here purely so they can be unit tested with node:test; the
// browser scripts duplicate the same mapping as plain JS (same reasoning
// as app.js's own formatAge comment: a build-stepless script can't import
// across the src/ts boundary, so the runtime copy is hand-kept in sync
// with this tested one).

import type { DisplayState } from "./record-view.ts";

export interface StateSymbol {
  /** The literal character(s) shown before the state word - empty for
   * "working", whose indicator is a CSS-drawn spinner with no glyph. */
  text: string;
  /** The CSS class carrying this symbol's color/shape. */
  cls: string;
}

const STATE_SYMBOLS: Record<DisplayState, StateSymbol> = {
  working: { text: "", cls: "symbol-spin" },
  "asked a question": { text: "?", cls: "symbol-question" },
  delivered: { text: "✓", cls: "symbol-check" },
  failed: { text: "✗", cls: "symbol-failed" },
  stopped: { text: "●", cls: "symbol-dot" },
  "closed (accept)": { text: "●", cls: "symbol-dot" },
  "closed (wrong)": { text: "●", cls: "symbol-dot" },
  closed: { text: "●", cls: "symbol-dot" },
};

export function stateSymbol(state: DisplayState): StateSymbol {
  return STATE_SYMBOLS[state];
}

export type RowEmphasis = "emphasis" | "fade" | "normal";

/** Failed and asked-a-question rows stand out more than the others; a
 * closed row (whichever ruling) fades back. Stopped stays normal - it
 * only gets the dimmer gray symbol above, not the fade treatment. */
export function rowEmphasis(state: DisplayState): RowEmphasis {
  if (state === "failed" || state === "asked a question") return "emphasis";
  if (state === "closed (accept)" || state === "closed (wrong)" || state === "closed") return "fade";
  return "normal";
}

/** Whether a scrollable area is at (or within `thresholdPx` of) its own
 * bottom - pure arithmetic so the "only auto-scroll when already at the
 * bottom" rule can be unit tested without a real DOM/browser. */
export function isScrolledToBottom(scrollTop: number, scrollHeight: number, clientHeight: number, thresholdPx = 4): boolean {
  return scrollHeight - scrollTop - clientHeight <= thresholdPx;
}
