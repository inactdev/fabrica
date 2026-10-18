// Plain JavaScript, no framework, no build step. Shared by both list pages
// (index.html = the live, open-tasks page; history.html = finished tasks)
// - which one decides the fetch endpoint and the empty-state wording, read
// straight off location.pathname; the server itself is what actually keeps
// an open task off /history and a finished one off /, not this script (see
// server.ts's /api/state vs /api/history). Polls every 2 seconds. The only
// thing this page ever sends the server is an ordinary GET - "now" (for
// the age column) comes back from the server's own response, never sent.
//
// Issue #203: a row now carries the full column set the record can
// answer for - state, task, project, worker and model, network policy,
// trigger, started, duration, cost (with its cap meter), checks,
// delivery, confidence. ONE DOM serves both layouts the Client asked
// for: above tablet width it is a table with a pinned header, and below
// it each row becomes a stacked card whose labels come from the cells'
// own `data-label` attributes via a CSS ::before (style.css). Nothing
// here reads a media query or re-renders on resize - a second renderer
// to keep in step with the first is exactly the kind of drift this
// directory's own comments keep warning about.
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

// When a task started, in the reader's own locale and time zone - the
// browser is the only party here that knows either, so the server sends
// the epoch milliseconds and this formats them. Deliberately short: the
// day and the clock time, no year and no seconds, since this column
// answers "when did this start" and the duration column beside it
// answers "how long ago".
function formatStarted(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Mirrors integrations/live-view/display.ts's projectName and meterFill -
// duplicated here for the same reason formatAge above is: a plain script
// with no build step can't import the tested .ts copy.
function projectName(path) {
  if (!path) return "—";
  const trimmed = path.replace(/[\\/]+$/, "");
  if (trimmed.length === 0) return "—";
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

function meterFill(costUsd, capUsd) {
  if (typeof capUsd !== "number" || !Number.isFinite(capUsd) || capUsd <= 0) return null;
  const fraction = Math.max(0, Math.min(1, costUsd / capUsd));
  return { fraction, level: fraction >= 1 ? "full" : fraction >= 0.8 ? "high" : "" };
}

// The DisplayState string (record-view.ts) to a flat, CSS-safe state
// class - the one color each row's state word gets.
const STATE_CLASS = {
  working: "state-working",
  "asked a question": "state-asking",
  delivered: "state-delivered",
  failed: "state-failed",
  stopped: "state-stopped",
  "stopped by you": "state-stopped-by-you",
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
  "stopped by you": { text: "■", cls: "symbol-stopped" },
  "closed (accept)": { text: "●", cls: "symbol-dot" },
  "closed (wrong)": { text: "●", cls: "symbol-dot" },
  closed: { text: "●", cls: "symbol-dot" },
};

function rowEmphasisClass(state) {
  if (state === "failed" || state === "asked a question") return "row-emphasis";
  if (state === "closed (accept)" || state === "closed (wrong)" || state === "closed") return "row-fade";
  if (state === "stopped by you") return "row-fade";
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

/** One column's cell. `data-label` is what the phone-width layout prints
 * in front of the value (style.css's ::before) - the same string the
 * table header shows above tablet width, so the two can never name the
 * same column differently. */
function cell(label, className, children) {
  return el("div", { className: `cell ${className || ""}`.trim(), "data-label": label }, children || [""]);
}

function buildRow(taskId) {
  const symbolEl = el("span", { className: "state-symbol" }, [""]);
  const stateEl = el("span", { className: "col-kind" }, [""]);
  const stateCell = cell("state", "cell-state", [el("span", { className: "state-wrap" }, [symbolEl, stateEl])]);

  const titleEl = el("span", { className: "cell-value" }, [""]);
  const taskCell = cell("task", "cell-task", [titleEl]);

  const projectEl = el("span", { className: "cell-value" }, [""]);
  const projectCell = cell("project", "", [projectEl]);

  const workerEl = el("span", { className: "cell-value" }, [""]);
  const workerCell = cell("worker · model", "", [workerEl]);

  const networkEl = el("span", { className: "cell-value" }, [""]);
  const networkCell = cell("network policy", "", [networkEl]);

  const triggerEl = el("span", { className: "cell-value" }, [""]);
  const triggerCell = cell("trigger", "", [triggerEl]);

  const startedEl = el("span", { className: "cell-value" }, [""]);
  const startedCell = cell("started", "", [startedEl]);

  const durationEl = el("span", { className: "cell-value" }, [""]);
  const durationCell = cell("duration", "", [durationEl]);

  // The cost cell carries its own meter, which exists only while the
  // task has a per-task cap to measure against (Client ruling: with no
  // cap set, show the cost as plain text and no meter).
  const costTextEl = el("span", { className: "cell-value" }, [""]);
  const meterFillEl = el("span", { className: "meter-fill" }, []);
  const meterEl = el("span", { className: "meter" }, [meterFillEl]);
  meterEl.hidden = true;
  const costCell = cell("cost", "cell-cost", [costTextEl, meterEl]);

  const checksEl = el("span", { className: "cell-value" }, [""]);
  const checksCell = cell("checks", "", [checksEl]);

  const deliveryEl = el("span", { className: "cell-value" }, [""]);
  const deliveryCell = cell("delivery", "", [deliveryEl]);

  const confidenceEl = el("span", { className: "cell-value" }, [""]);
  const confidenceCell = cell("confidence", "", [confidenceEl]);

  const rowEl = el(
    "div",
    {
      className: "task-row",
      onclick: () => {
        location.href = `/tasks/${taskId}`;
      },
    },
    [
      stateCell,
      taskCell,
      projectCell,
      workerCell,
      networkCell,
      triggerCell,
      startedCell,
      durationCell,
      costCell,
      checksCell,
      deliveryCell,
      confidenceCell,
    ]
  );

  return {
    el: rowEl,
    symbolEl,
    stateEl,
    titleEl,
    projectEl,
    projectCell,
    workerEl,
    networkEl,
    triggerEl,
    startedEl,
    durationEl,
    costTextEl,
    meterEl,
    meterFillEl,
    checksEl,
    deliveryEl,
    confidenceEl,
    last: {},
  };
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

function setAttr(node, lastKey, refs, name, value) {
  if (refs.last[lastKey] === value) return;
  node.setAttribute(name, value);
  refs.last[lastKey] = value;
}

// The cost column: always the same words `fabrica status` uses for this
// task (the server sends describeTaskCost's own string), plus the cap it
// is held to and a meter of how much of it is gone. No cap, no meter -
// the cost stands alone as plain text.
function updateCost(refs, task) {
  // Metered dollars only - the per-task cap binds on nothing else
  // (issue #188), so a subscription estimate must not move this bar.
  const fill = meterFill(task.costUsd, task.perTaskCapUsd);
  setText(
    refs.costTextEl,
    "cost",
    refs,
    fill ? `${task.costLabel} of $${task.perTaskCapUsd.toFixed(2)}` : task.costLabel
  );

  const shown = fill !== null;
  if (refs.last.meterShown !== shown) {
    refs.meterEl.hidden = !shown;
    refs.last.meterShown = shown;
  }
  if (!fill) return;

  const width = `${(fill.fraction * 100).toFixed(1)}%`;
  if (refs.last.meterWidth !== width) {
    refs.meterFillEl.style.width = width;
    refs.last.meterWidth = width;
  }
  setClass(refs.meterFillEl, "meterCls", refs, `meter-fill ${fill.level ? `meter-${fill.level}` : ""}`.trim());
}

function updateRow(refs, task) {
  const symbol = STATE_SYMBOL[task.state] || { text: "", cls: "" };
  setText(refs.symbolEl, "symbolText", refs, symbol.text);
  setClass(refs.symbolEl, "symbolCls", refs, `state-symbol ${symbol.cls}`);

  setText(refs.stateEl, "stateText", refs, task.state);
  setClass(refs.stateEl, "stateCls", refs, `col-kind ${STATE_CLASS[task.state] || ""}`);

  setText(refs.titleEl, "title", refs, task.title);
  setText(refs.projectEl, "project", refs, projectName(task.project));
  setAttr(refs.projectCell, "projectTitle", refs, "title", task.project || "");
  setText(refs.workerEl, "worker", refs, task.worker || "—");
  setText(refs.networkEl, "network", refs, task.networkPolicy);
  setText(refs.triggerEl, "trigger", refs, task.trigger);
  setText(refs.startedEl, "started", refs, formatStarted(task.startedAtMs));
  // The server already decided whether this duration is still running
  // (now - started) or frozen at what the task last recorded - this only
  // formats it, so an open and a finished task can't drift apart here.
  setText(refs.durationEl, "duration", refs, task.startedAtMs === null ? "—" : formatAge(task.durationMs));

  updateCost(refs, task);

  setText(refs.checksEl, "checks", refs, task.checks);
  setText(refs.deliveryEl, "delivery", refs, task.delivery || "—");
  setText(refs.confidenceEl, "confidence", refs, task.confidence === null ? "—" : `${task.confidence}%`);

  setClass(refs.el, "rowCls", refs, `task-row ${rowEmphasisClass(task.state)}`.trim());
}

function renderTasks(state) {
  renderSpend(state.spend);

  const countEl = document.getElementById("count");
  const countText = String(state.tasks.length);
  if (countEl.textContent !== countText) countEl.textContent = countText;

  const container = document.getElementById("tasks");
  const headEl = document.getElementById("task-head");

  if (state.tasks.length === 0) {
    for (const refs of rows.values()) refs.el.remove();
    rows.clear();
    if (headEl) headEl.hidden = true;
    if (!container.querySelector(".empty")) {
      container.replaceChildren(el("p", { className: "empty" }, [EMPTY_MESSAGE]));
    }
    return;
  }

  if (headEl) headEl.hidden = false;
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
    updateRow(refs, task);

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
