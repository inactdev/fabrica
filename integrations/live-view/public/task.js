// Plain JavaScript, no framework, no build step. One task's full detail
// page: the event stream on the left, the task's own details in a column
// on the right. Polls the server every 2 seconds, same as the list page.
// The active filter, the tail toggle, and which rows are expanded are all
// local UI state - never sent to the server, nothing new is ever fetched
// beyond the two endpoints this page already called before.

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
  return [
    field("What", writeup.what),
    field("Why", writeup.why),
    field("How", writeup.how),
    field("Deviations", writeup.deviations),
  ];
}

function renderTask(task) {
  document.getElementById("task-title").textContent = task.title;
  const stateEl = document.getElementById("task-state");
  stateEl.textContent = task.state;
  stateEl.className = STATE_CLASS[task.state] || "";

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
        if (window.__lastTranscript) renderTranscript(window.__lastTranscript);
      },
    },
    [line]
  );
  row.dataset.bucket = bucket;
  return row;
}

function renderTranscript(transcript) {
  window.__lastTranscript = transcript;
  const shown = transcript
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => activeFilter === "all" || entryKindInfo(entry.kind).bucket === activeFilter);

  document.getElementById("count").textContent = String(shown.length);

  const container = document.getElementById("transcript");
  container.replaceChildren(
    ...(shown.length
      ? shown.map(({ entry, index }) => renderTranscriptRow(entry, index))
      : [el("p", { className: "empty" }, ["No transcript yet."])])
  );

  if (tailOn) container.scrollIntoView({ block: "end" });
}

function setActiveFilter(filter) {
  activeFilter = filter;
  for (const btn of document.querySelectorAll(".filters .filter-btn[data-filter]")) {
    btn.classList.toggle("active", btn.dataset.filter === filter);
  }
  if (window.__lastTranscript) renderTranscript(window.__lastTranscript);
}

function setTail(on) {
  tailOn = on;
  const btn = document.getElementById("tail-toggle");
  btn.textContent = `Tail: ${on ? "on" : "off"}`;
  btn.classList.toggle("active", on);
  if (on && window.__lastTranscript) renderTranscript(window.__lastTranscript);
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
  renderTask(body.task);
}

async function loadTranscript() {
  const res = await fetch(`/api/tasks/${encodeURIComponent(TASK_ID)}/transcript`);
  if (!res.ok) return;
  const body = await res.json();
  if (body.error) {
    showError(body.error);
    return;
  }
  clearError();
  renderTranscript(body.transcript);
}

function poll() {
  loadTask();
  loadTranscript();
}

poll();
setInterval(poll, POLL_MS);
