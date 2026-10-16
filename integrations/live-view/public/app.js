// Plain JavaScript, no framework, no build step. Shared by both list pages
// (index.html = the live, open-tasks page; history.html = finished tasks)
// - which one decides the fetch endpoint and the empty-state wording, read
// straight off location.pathname; the server itself is what actually keeps
// an open task off /history and a finished one off /, not this script (see
// server.ts's /api/state vs /api/history). Polls every 2 seconds. The only
// thing this page ever sends the server is an ordinary GET - "now" (for
// the age column) comes back from the server's own response, never sent.
//
// Every poll re-fetches the full list, but a task's existing row is never
// torn down and rebuilt - only the specific text/class that actually
// changed gets written, and a write is skipped entirely when the new value
// equals the old one. That's what stops a steady 2-second poll from
// jumping the page while someone's reading it: an unchanged row is never
// touched at all.

const POLL_MS = 2000;
const IS_HISTORY = location.pathname === "/history";
const STATE_ENDPOINT = IS_HISTORY ? "/api/history" : "/api/state";
const EMPTY_MESSAGE = IS_HISTORY ? "No finished tasks yet." : "No open tasks.";

function el(tag, props, children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (key === "className") node.className = value;
    else if (key === "onclick") node.addEventListener("click", value);
    else node.setAttribute(key, value);
  }
  for (const child of children || []) {
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

// Mirrors src/cli/render.ts's formatAge - a compact, human age like "3s",
// "12m", "4h15m" - duplicated here (a plain script with no build step
// can't import across the src/ boundary) rather than invented fresh.
function formatAge(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  const remMinutes = totalMinutes % 60;
  if (totalHours < 24) return remMinutes > 0 ? `${totalHours}h${remMinutes}m` : `${totalHours}h`;
  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
}

// The DisplayState string (record-view.ts) to a flat, CSS-safe state
// class - the one color each row's state word gets.
const STATE_CLASS = {
  working: "state-working",
  "asked a question": "state-asking",
  delivered: "state-delivered",
  failed: "state-failed",
  stopped: "state-stopped",
  "closed (accept)": "state-accept",
  "closed (wrong)": "state-wrong",
  closed: "state-closed",
};

// Mirrors integrations/live-view/display.ts's stateSymbol/rowEmphasis -
// duplicated here for the same reason formatAge above is: a plain script
// with no build step can't import the tested .ts copy. "working" has no
// text glyph - its indicator is the CSS-drawn spinner (symbol-spin) below.
const STATE_SYMBOL = {
  working: { text: "", cls: "symbol-spin" },
  "asked a question": { text: "?", cls: "symbol-question" },
  delivered: { text: "✓", cls: "symbol-check" },
  failed: { text: "✗", cls: "symbol-failed" },
  stopped: { text: "●", cls: "symbol-dot" },
  "closed (accept)": { text: "●", cls: "symbol-dot" },
  "closed (wrong)": { text: "●", cls: "symbol-dot" },
  closed: { text: "●", cls: "symbol-dot" },
};

function rowEmphasisClass(state) {
  if (state === "failed" || state === "asked a question") return "row-emphasis";
  if (state === "closed (accept)" || state === "closed (wrong)" || state === "closed") return "row-fade";
  return "";
}

function renderSpend(spend) {
  const spendEl = document.getElementById("spend");
  if (!spendEl) return; // history.html has no spend line
  const bits = [`Today: ${spend.dailyLabel}`];
  bits.push(spend.perDayCapUsd === undefined ? "(no daily cap set)" : `of $${spend.perDayCapUsd.toFixed(2)} daily cap`);
  if (spend.dailySubscriptionUsd > 0) bits.push(`+ ~${spend.dailySubscriptionLabel} subscription-estimate`);
  if (spend.perTaskCapUsd !== undefined) bits.push(`— per-task cap $${spend.perTaskCapUsd.toFixed(2)}`);
  const text = bits.join(" ");
  if (spendEl.textContent !== text) spendEl.textContent = text;
}

// One entry per task currently rendered as a row - kept across polls so an
// unchanged task's DOM node is reused rather than recreated, and so each
// displayed field can be compared against what's already on screen before
// writing to it.
const rows = new Map();

function buildRow(taskId) {
  const ageEl = el("span", { className: "col-dim" }, [""]);
  const symbolEl = el("span", { className: "state-symbol" }, [""]);
  const stateEl = el("span", { className: "col-kind" }, [""]);
  const stateWrap = el("span", { className: "state-wrap" }, [symbolEl, stateEl]);
  const titleEl = el("span", { className: "col-title" }, [""]);
  const line = el("div", { className: "row-line" }, [ageEl, stateWrap, titleEl]);
  const rowEl = el("div", { className: "row", onclick: () => { location.href = `/tasks/${taskId}`; } }, [line]);
  return { el: rowEl, ageEl, symbolEl, stateEl, titleEl, last: {} };
}

function setText(node, lastKey, refs, value) {
  if (refs.last[lastKey] === value) return;
  node.textContent = value;
  refs.last[lastKey] = value;
}

function setClass(node, lastKey, refs, value) {
  if (refs.last[lastKey] === value) return;
  node.className = value;
  refs.last[lastKey] = value;
}

function updateRow(refs, task, now) {
  setText(refs.ageEl, "age", refs, formatAge(now - task.lastActivityMs));

  const symbol = STATE_SYMBOL[task.state] || { text: "", cls: "" };
  setText(refs.symbolEl, "symbolText", refs, symbol.text);
  setClass(refs.symbolEl, "symbolCls", refs, `state-symbol ${symbol.cls}`);

  setText(refs.stateEl, "stateText", refs, task.state);
  setClass(refs.stateEl, "stateCls", refs, `col-kind ${STATE_CLASS[task.state] || ""}`);

  setText(refs.titleEl, "title", refs, task.title);

  setClass(refs.el, "rowCls", refs, `row ${rowEmphasisClass(task.state)}`.trim());
}

function renderTasks(state) {
  renderSpend(state.spend);

  const countEl = document.getElementById("count");
  const countText = String(state.tasks.length);
  if (countEl.textContent !== countText) countEl.textContent = countText;

  const container = document.getElementById("tasks");

  if (state.tasks.length === 0) {
    for (const refs of rows.values()) refs.el.remove();
    rows.clear();
    if (!container.querySelector(".empty")) {
      container.replaceChildren(el("p", { className: "empty" }, [EMPTY_MESSAGE]));
    }
    return;
  }

  const existingEmpty = container.querySelector(".empty");
  if (existingEmpty) existingEmpty.remove();

  const seen = new Set();
  let prevEl = null;
  for (const task of state.tasks) {
    seen.add(task.id);
    let refs = rows.get(task.id);
    if (!refs) {
      refs = buildRow(task.id);
      rows.set(task.id, refs);
    }
    updateRow(refs, task, state.now);

    const expectedNext = prevEl ? prevEl.nextSibling : container.firstChild;
    if (expectedNext !== refs.el) container.insertBefore(refs.el, expectedNext);
    prevEl = refs.el;
  }

  for (const [id, refs] of rows) {
    if (!seen.has(id)) {
      refs.el.remove();
      rows.delete(id);
    }
  }
}

function showError(message) {
  const errorEl = document.getElementById("error");
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function clearError() {
  const errorEl = document.getElementById("error");
  errorEl.hidden = true;
  errorEl.textContent = "";
}

async function loadState() {
  const res = await fetch(STATE_ENDPOINT);
  if (!res.ok) return;
  const state = await res.json();
  if (state.error) {
    // The server answered - it just could not build the page state this
    // time (a corrupt or unexpectedly-shaped record). Say so and leave
    // whatever was last successfully rendered in place, rather than
    // wiping it for one bad poll.
    showError(state.error);
    return;
  }
  clearError();
  renderTasks(state);
}

loadState();
setInterval(loadState, POLL_MS);
