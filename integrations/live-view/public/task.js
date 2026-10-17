// Plain JavaScript, no framework, no build step. One task's full detail
// page: the event stream on the left, the task's own details in a column
// on the right. Polls the server every 2 seconds, same as the list page.
// The active filter, the tail toggle, and which rows are expanded are all
// local UI state - never sent to the server, nothing new is ever fetched
// beyond the two endpoints this page already called before.
//
// Two things a steady poll used to get wrong, now fixed: (1) a poll that
// changed nothing touches nothing - the sidebar is only re-rendered when
// its data actually differs from what's already on screen, and the
// transcript only ever gets new rows appended for genuinely new entries
// (the record is append-only, so "new" just means "past what was already
// rendered") rather than every row being torn down and rebuilt; (2) with
// "Tail: on", a poll only scrolls to the bottom if the view was already
// there - scrolling up to read no longer gets yanked back down every 2s.

const POLL_MS = 2000;
const TASK_ID = location.pathname.replace(/^\/tasks\//, "");

let activeFilter = "all";
let tailOn = true;
const expanded = new Set();

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

// Mirrors integrations/live-view/display.ts's stateSymbol - see app.js's
// identical copy for why this is duplicated rather than imported.
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

// Mirrors integrations/live-view/display.ts's isScrolledToBottom - same
// duplication reasoning, applied to the one window-level scroll position
// this page ever reads.
function isScrolledToBottom(thresholdPx = 4) {
  const scroller = document.scrollingElement || document.documentElement;
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= thresholdPx;
}

// Which of the four filter buckets a transcript entry's own `kind`
// belongs to, and the one color its kind word gets - tool use and
// thinking are blue, plain text is the page's ordinary light gray,
// anything naming an error is red, and the adapter's own bookkeeping
// entries (usage, budget-exhausted) are the "system" green bucket.
function entryKindInfo(kind) {
  if (kind.includes("error")) return { bucket: "errors", cls: "kind-error" };
  if (kind === "usage" || kind === "budget-exhausted") return { bucket: "system", cls: "kind-system" };
  if (kind === "text") return { bucket: "worker", cls: "kind-text" };
  return { bucket: "worker", cls: "kind-toolthink" };
}

function matchesActiveFilter(entry) {
  return activeFilter === "all" || entryKindInfo(entry.kind).bucket === activeFilter;
}

function formatTime(occurredAt) {
  const d = new Date(occurredAt);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function costLine(task) {
  if (task.costLabel === "no attempts yet") return "no attempts yet";
  const bits = [task.costLabel];
  if (task.perTaskCapUsd !== undefined) bits.push(`of $${task.perTaskCapUsd.toFixed(2)} cap`);
  return bits.join(" ");
}

function field(label, valueNode) {
  return el("div", { className: "field" }, [
    el("span", { className: "field-label" }, [label]),
    el("div", { className: "field-value" }, [valueNode]),
  ]);
}

function renderWriteup(writeup) {
  const whatToLookAt = [
    `Confidence: ${writeup.confidence}/100`,
    `Assumptions: ${writeup.assumptions}`,
    `Expected outcomes: ${writeup.expectedOutcomes}`,
    `Deviations: ${writeup.deviations}`,
  ].join("\n");
  return [
    field("What", writeup.what),
    field("Why", writeup.why),
    field("How", writeup.how),
    field("What to look at", whatToLookAt),
  ];
}

let lastTaskJson = null;

function renderTask(task) {
  document.getElementById("task-title").textContent = task.title;

  const stateEl = document.getElementById("task-state");
  const symbol = STATE_SYMBOL[task.state] || { text: "", cls: "" };
  stateEl.replaceChildren(
    el("span", { className: `state-symbol ${symbol.cls}` }, [symbol.text]),
    el("span", { className: STATE_CLASS[task.state] || "" }, [` ${task.state}`])
  );

  const fields = [
    field("Task", task.taskText || "(no task text)"),
    field("Project", task.project || "unknown project"),
    field("Attempt", task.attempt === null ? "no attempts yet" : `attempt ${task.attempt}`),
    field("Cost", costLine(task)),
  ];
  if (task.prUrl) fields.push(field("Pull request", el("a", { href: task.prUrl }, [task.prUrl])));
  if (task.writeup) fields.push(...renderWriteup(task.writeup));

  document.getElementById("task-detail").replaceChildren(...fields);
}

function renderTranscriptRow(entry, index) {
  const { bucket, cls } = entryKindInfo(entry.kind);
  const isExpanded = expanded.has(index);
  const counter = el("span", { className: "col-counter" }, [String(index + 1).padStart(6, "0")]);
  const time = el("span", { className: "col-dim" }, [formatTime(entry.occurredAt)]);
  const kind = el("span", { className: `col-kind ${cls}` }, [entry.kind]);
  const content = el("span", { className: "col-content" }, [entry.text]);
  const line = el("div", { className: "row-line" }, [counter, time, kind, content]);
  const row = el(
    "div",
    {
      className: `row${isExpanded ? " expanded" : ""}`,
      onclick: () => {
        if (expanded.has(index)) expanded.delete(index);
        else expanded.add(index);
        if (window.__lastTranscript) fullRenderTranscript(window.__lastTranscript);
      },
    },
    [line]
  );
  row.dataset.bucket = bucket;
  return row;
}

function updateCount(n) {
  const countEl = document.getElementById("count");
  const text = String(n);
  if (countEl.textContent !== text) countEl.textContent = text;
}

/** Only called for a filter change, an expand/collapse click, or the very
 * first load - a full rebuild of every visible row, respecting the active
 * filter and which rows are expanded. A steady poll never takes this path
 * once the page has loaded once; see appendNewTranscriptRows below. */
function fullRenderTranscript(transcript) {
  window.__lastTranscript = transcript;
  const wasAtBottom = isScrolledToBottom();

  const shown = transcript
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => matchesActiveFilter(entry));

  updateCount(shown.length);

  const container = document.getElementById("transcript");
  container.replaceChildren(
    ...(shown.length
      ? shown.map(({ entry, index }) => renderTranscriptRow(entry, index))
      : [el("p", { className: "empty" }, ["No transcript yet."])])
  );
  renderedCount = transcript.length;

  maybeScrollToBottom(wasAtBottom);
}

/** The poll path: the record is append-only, so a growing transcript only
 * ever means new entries past `renderedCount` - append just those, never
 * touch a row already on screen. Returns false (and touches nothing) when
 * nothing new arrived. */
let renderedCount = 0;
function appendNewTranscriptRows(transcript) {
  window.__lastTranscript = transcript;
  const newEntries = transcript.slice(renderedCount);
  if (newEntries.length === 0) return false;

  const wasAtBottom = isScrolledToBottom();
  const container = document.getElementById("transcript");
  const emptyEl = container.querySelector(".empty");

  let appended = false;
  newEntries.forEach((entry, i) => {
    const index = renderedCount + i;
    if (!matchesActiveFilter(entry)) return;
    if (emptyEl && !appended) emptyEl.remove();
    container.appendChild(renderTranscriptRow(entry, index));
    appended = true;
  });

  renderedCount = transcript.length;
  updateCount(container.querySelectorAll(".row").length);

  if (appended) maybeScrollToBottom(wasAtBottom);
  return true;
}

function maybeScrollToBottom(wasAtBottom) {
  if (!tailOn || !wasAtBottom) return;
  document.getElementById("transcript").scrollIntoView({ block: "end" });
}

function setActiveFilter(filter) {
  activeFilter = filter;
  for (const btn of document.querySelectorAll(".filters .filter-btn[data-filter]")) {
    btn.classList.toggle("active", btn.dataset.filter === filter);
  }
  if (window.__lastTranscript) fullRenderTranscript(window.__lastTranscript);
}

function setTail(on) {
  tailOn = on;
  const btn = document.getElementById("tail-toggle");
  btn.textContent = `Tail: ${on ? "on" : "off"}`;
  btn.classList.toggle("active", on);
  // Turning tail on is an explicit "take me to the bottom" action - it
  // jumps there regardless of where the view currently is, unlike the
  // poll-driven scroll below which only ever follows if already there.
  if (on) document.getElementById("transcript").scrollIntoView({ block: "end" });
}

for (const btn of document.querySelectorAll(".filters .filter-btn[data-filter]")) {
  btn.addEventListener("click", () => setActiveFilter(btn.dataset.filter));
}
document.getElementById("tail-toggle").addEventListener("click", () => setTail(!tailOn));
setActiveFilter("all");
setTail(true);

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

async function loadTask() {
  const res = await fetch(`/api/tasks/${encodeURIComponent(TASK_ID)}`);
  if (res.status === 404) {
    document.getElementById("task-title").textContent = "No such task.";
    return;
  }
  if (!res.ok) return;
  const body = await res.json();
  if (body.error) {
    showError(body.error);
    return;
  }
  clearError();
  const json = JSON.stringify(body.task);
  if (json === lastTaskJson) return;
  lastTaskJson = json;
  renderTask(body.task);
}

let transcriptLoaded = false;
async function loadTranscript() {
  const res = await fetch(`/api/tasks/${encodeURIComponent(TASK_ID)}/transcript`);
  if (!res.ok) return;
  const body = await res.json();
  if (body.error) {
    showError(body.error);
    return;
  }
  clearError();
  if (!transcriptLoaded) {
    fullRenderTranscript(body.transcript);
    transcriptLoaded = true;
  } else {
    appendNewTranscriptRows(body.transcript);
  }
}

function poll() {
  loadTask();
  loadTranscript();
}

poll();
setInterval(poll, POLL_MS);
