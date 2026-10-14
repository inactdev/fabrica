// Plain JavaScript, no framework, no build step. Polls the server every
// 2 seconds. The only thing this page ever sends the server is which task
// id (if any) is currently expanded, and only to read that one task back -
// there are no forms and no other requests, to this server or anyone else.

const POLL_MS = 2000;
let expandedTaskId = null;

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

function renderSpend(spend) {
  const bits = [`Today: ${spend.dailyLabel}`];
  bits.push(spend.perDayCapUsd === undefined ? "(no daily cap set)" : `of $${spend.perDayCapUsd.toFixed(2)} daily cap`);
  if (spend.perTaskCapUsd !== undefined) bits.push(`— per-task cap $${spend.perTaskCapUsd.toFixed(2)}`);
  document.getElementById("spend").textContent = bits.join(" ");
}

// The one phrase that covers both "which attempt" and "cost so far" when
// there's genuinely nothing to report yet - gated on costLabel itself
// (the literal source of that phrase), not on task.attempt, since an
// attempt already in flight (a heartbeat, no receipt yet) can have a real
// attempt number while its cost is still "no attempts yet".
function taskMetaLine(task) {
  const bits = [task.project || "unknown project"];
  if (task.costLabel === "no attempts yet") {
    bits.push("no attempts yet");
    return bits.join("  ·  ");
  }
  bits.push(task.attempt === null ? "no attempts yet" : `attempt ${task.attempt}`);
  const costBits = [task.costLabel];
  if (task.perTaskCapUsd !== undefined) costBits.push(`of $${task.perTaskCapUsd.toFixed(2)} cap`);
  bits.push(costBits.join(" "));
  return bits.join("  ·  ");
}

function renderWriteup(writeup) {
  const section = (label, text) =>
    el("p", { className: "writeup-section" }, [el("span", { className: "writeup-label" }, [`${label}: `]), text]);
  return el("div", { className: "writeup" }, [section("What", writeup.what), section("Why", writeup.why), section("How", writeup.how)]);
}

function renderExpanded(task) {
  const children = [
    el("p", { className: "task-text" }, [task.taskText || "(no task text)"]),
    el("p", { className: "task-meta" }, [taskMetaLine(task)]),
  ];
  if (task.prUrl) children.push(el("p", { className: "task-meta" }, [el("a", { href: task.prUrl }, [task.prUrl])]));
  if (task.writeup) children.push(renderWriteup(task.writeup));
  children.push(el("p", { className: "task-meta" }, [el("a", { href: `/tasks/${task.id}` }, ["Full details and transcript →"])]));
  return el("div", { className: "task-expanded" }, children);
}

// Each row shows only the title and the state word - nothing else, so
// rows stay short and the state actually stands out. Everything else is
// one click away, either inline (renderExpanded) or on the task's own
// page (/tasks/<id>, for the transcript).
function renderTask(task) {
  const row = el("p", { className: "task-row" }, [el("span", { className: "task-title" }, [task.title]), el("span", { className: "state" }, [task.state])]);
  const children = [row];
  if (task.id === expandedTaskId) children.push(renderExpanded(task));
  return el("div", { className: "task", onclick: () => toggleTask(task.id) }, children);
}

function toggleTask(taskId) {
  expandedTaskId = expandedTaskId === taskId ? null : taskId;
  if (window.__lastState) renderTasks(window.__lastState);
}

function renderTasks(state) {
  window.__lastState = state;
  renderSpend(state.spend);

  const open = state.tasks.filter((t) => !t.finished);
  const history = state.tasks.filter((t) => t.finished);

  const openContainer = document.getElementById("open-tasks");
  openContainer.replaceChildren(...(open.length ? open.map(renderTask) : [el("p", { className: "empty" }, ["No open tasks."])]));

  const historyContainer = document.getElementById("history-tasks");
  historyContainer.replaceChildren(
    ...(history.length ? history.map(renderTask) : [el("p", { className: "empty" }, ["No finished tasks yet."])])
  );
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
