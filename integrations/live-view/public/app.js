// Plain JavaScript, no framework, no build step. Polls the server every
// 2 seconds and never sends it anything but which task id (if any) is
// currently expanded - this page has no forms and makes no other
// requests of any kind, to this server or anyone else.

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

function taskLine(task) {
  const bits = [task.id, task.project || "unknown project"];
  const costBits = [task.costLabel];
  if (task.perTaskCapUsd !== undefined) costBits.push(`of $${task.perTaskCapUsd.toFixed(2)} cap`);
  bits.push(task.attempt === null ? "no attempts yet" : `attempt ${task.attempt}`);
  bits.push(costBits.join(" "));
  return bits.join("  ·  ");
}

function renderTask(task) {
  const children = [
    el("p", { className: "task-line" }, [
      el("span", { className: "task-id" }, [task.id + "  "]),
      el("span", { className: "state" }, [task.state]),
    ]),
    el("p", { className: "task-line" }, [taskLine(task)]),
    el("p", { className: "task-text" }, [task.taskText || "(no task text)"]),
  ];
  if (task.prUrl) {
    children.push(el("p", { className: "task-line" }, [el("a", { href: task.prUrl }, [task.prUrl])]));
  }
  if (task.id === expandedTaskId) {
    children.push(el("div", { className: "transcript", id: "transcript" }, ["Loading transcript…"]));
  }
  return el("div", { className: "task", onclick: () => toggleTask(task.id) }, children);
}

function toggleTask(taskId) {
  expandedTaskId = expandedTaskId === taskId ? null : taskId;
  if (window.__lastState) renderTasks(window.__lastState);
  if (expandedTaskId) loadTranscript();
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

async function loadState() {
  const res = await fetch("/api/state");
  if (!res.ok) return;
  renderTasks(await res.json());
}

async function loadTranscript() {
  if (!expandedTaskId) return;
  const res = await fetch(`/api/tasks/${encodeURIComponent(expandedTaskId)}/transcript`);
  const container = document.getElementById("transcript");
  if (!container) return;
  if (!res.ok) {
    container.replaceChildren(document.createTextNode("No transcript yet."));
    return;
  }
  const { transcript } = await res.json();
  container.replaceChildren(
    ...(transcript.length
      ? transcript.map((entry) =>
          el("p", { className: "transcript-entry" }, [el("span", { className: "transcript-kind" }, [`[${entry.kind}] `]), entry.text])
        )
      : [document.createTextNode("No transcript yet.")])
  );
}

function poll() {
  loadState();
  loadTranscript();
}

poll();
setInterval(poll, POLL_MS);
