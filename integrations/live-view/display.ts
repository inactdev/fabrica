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
  // Issue #203: the Client's own stop gets a square rather than the
  // gray dot every other finished-without-a-verdict state wears - it is
  // the one outcome on this page he caused himself, and it should be
  // findable at a glance among them.
  "stopped by you": { text: "■", cls: "symbol-stopped" },
  "closed (accept)": { text: "●", cls: "symbol-dot" },
  "closed (wrong)": { text: "●", cls: "symbol-dot" },
  closed: { text: "●", cls: "symbol-dot" },
};

export function stateSymbol(state: DisplayState): StateSymbol {
  return STATE_SYMBOLS[state];
}

export type RowEmphasis = "emphasis" | "fade" | "normal";

/** Failed and asked-a-question rows stand out more than the others; a
 * closed row (whichever ruling) fades back, and so does one the Client
 * stopped himself - he already knows about that one. Stopped (as in
 * Inspector reached no verdict) stays normal: it only gets the dimmer
 * gray symbol above, not the fade treatment. */
export function rowEmphasis(state: DisplayState): RowEmphasis {
  if (state === "failed" || state === "asked a question") return "emphasis";
  if (state === "closed (accept)" || state === "closed (wrong)" || state === "closed") return "fade";
  if (state === "stopped by you") return "fade";
  return "normal";
}

/** The project's own folder name - what identifies it at a glance in a
 * column too narrow for a whole path (the full path goes on the cell's
 * title attribute). Trailing separators are dropped first, so a path
 * registered with one doesn't read as an empty name, and a project with
 * no path recorded yet reads as an em dash rather than blank. */
export function projectName(path: string | null): string {
  if (!path) return "—";
  const trimmed = path.replace(/[\\/]+$/, "");
  if (trimmed.length === 0) return "—";
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

/** How full the per-task cost meter is, 0 to 1, and which of its three
 * colors that is (issue #203). Pure arithmetic, for the same reason
 * `isScrolledToBottom` below is: the page's own copy of this runs in a
 * browser with no test harness. Clamped at both ends - a task past its
 * cap shows a full bar, never one that overflows its track - and
 * measured on metered dollars alone, since that is the only spend the
 * per-task cap binds on (issue #188). A cap of zero or less has no
 * meaningful fraction and is treated as no meter at all, the same as an
 * absent one. */
export function meterFill(costUsd: number, capUsd: number | undefined): { fraction: number; level: "" | "high" | "full" } | null {
  if (typeof capUsd !== "number" || !Number.isFinite(capUsd) || capUsd <= 0) return null;
  const fraction = Math.max(0, Math.min(1, costUsd / capUsd));
  return { fraction, level: fraction >= 1 ? "full" : fraction >= 0.8 ? "high" : "" };
}

/** What the review page actually sends as a verdict's note, given
 * whatever is in that card's note box.
 *
 * `undefined` means "send no note at all" - the POST leaves the `note`
 * key off entirely, which is the identical request a note-less accept
 * has always sent, and lands on the record exactly as `fabrica verdict
 * <id> accept` with no `-m` does (Client ruling: an empty box is as if
 * `-m` were never passed, not an empty note recorded). Whitespace-only
 * counts as empty, since a stray space is not a reaction.
 *
 * Trimmed when there is text, for the same reason `fabrica verdict`'s
 * own note is: it goes verbatim into the task's `verdict` file and the
 * `verdict-recorded` event. Pure, so the rule can be unit tested here
 * rather than only in a browser (review.js keeps a hand-duplicated
 * copy, same as every other function in this file). */
export function noteToSend(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Whether a scrollable area is at (or within `thresholdPx` of) its own
 * bottom - pure arithmetic so the "only auto-scroll when already at the
 * bottom" rule can be unit tested without a real DOM/browser. */
export function isScrolledToBottom(scrollTop: number, scrollHeight: number, clientHeight: number, thresholdPx = 4): boolean {
  return scrollHeight - scrollTop - clientHeight <= thresholdPx;
}
