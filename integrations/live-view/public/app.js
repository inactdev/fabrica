// Plain JavaScript, no framework, no build step. Polls the server every
// 2 seconds. The only thing this page ever sends the server is an
// ordinary GET for /api/state - the active filter and "now" used for the
// age column are purely local UI state, never sent anywhere.

const POLL_MS = 2000;
let activeFilter = "all";

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

function renderSpend(spend) {
  const bits = [`Today: ${spend.dailyLabel}`];
  bits.push(spend.perDayCapUsd === undefined ? "(no daily cap set)" : `of $${spend.perDayCapUsd.toFixed(2)} daily cap`);
  if (spend.perTaskCapUsd !== undefined) bits.push(`— per-task cap $${spend.perTaskCapUsd.toFixed(2)}`);
  document.getElementById("spend").textContent = bits.join(" ");
}

function renderTaskRow(task, now) {
  const age = el("span", { className: "col-dim" }, [formatAge(now - task.lastActivityMs)]);
  const state = el("span", { className: `col-kind ${STATE_CLASS[task.state] || ""}` }, [task.state]);
  const title = el("span", { className: "col-title" }, [task.title]);
  const line = el("div", { className: "row-line" }, [age, state, title]);
  return el("div", { className: "row", onclick: () => { location.href = `/tasks/${task.id}`; } }, [line]);
}

function matchesFilter(task) {
  if (activeFilter === "open") return !task.finished;
  if (activeFilter === "history") return task.finished;
  return true;
}

function renderTasks(state) {
  window.__lastState = state;
  renderSpend(state.spend);

  const shown = state.tasks.filter(matchesFilter);
  document.getElementById("count").textContent = String(shown.length);

  const container = document.getElementById("tasks");
  container.replaceChildren(
    ...(shown.length ? shown.map((task) => renderTaskRow(task, state.now)) : [el("p", { className: "empty" }, ["No tasks to show."])])
  );
}

function setActiveFilter(filter) {
  activeFilter = filter;
  for (const btn of document.querySelectorAll(".filter-btn")) {
    btn.classList.toggle("active", btn.dataset.filter === filter);
  }
  if (window.__lastState) renderTasks(window.__lastState);
}

for (const btn of document.querySelectorAll(".filter-btn")) {
  btn.addEventListener("click", () => setActiveFilter(btn.dataset.filter));
}
setActiveFilter("all");

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
  const res = await fetch("/api/state");
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
