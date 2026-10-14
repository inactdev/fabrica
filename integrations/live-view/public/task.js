// Plain JavaScript, no framework, no build step. One task's full detail
// page (issue: "styling the live app better" - the live transcript is
// too much to expand in place on the list page, so it gets a page of its
// own). Polls the server every 2 seconds, same as the list page.

const POLL_MS = 2000;
const TASK_ID = location.pathname.replace(/^\/tasks\//, "");

function el(tag, props, children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (key === "className") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children || []) {
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function metaLine(task) {
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
  return el("div", { className: "writeup" }, [
    section("What", writeup.what),
    section("Why", writeup.why),
    section("How", writeup.how),
    section("Deviations", writeup.deviations),
  ]);
}

function renderTask(task) {
  document.getElementById("task-title").textContent = task.title;
  document.getElementById("task-state").textContent = task.state;

  const children = [
    el("p", { className: "task-text" }, [task.taskText || "(no task text)"]),
    el("p", { className: "task-meta" }, [metaLine(task)]),
  ];
  if (task.prUrl) children.push(el("p", { className: "task-meta" }, [el("a", { href: task.prUrl }, [task.prUrl])]));
  if (task.writeup) children.push(renderWriteup(task.writeup));

  document.getElementById("task-detail").replaceChildren(...children);
}

function renderTranscript(transcript) {
  const container = document.getElementById("transcript");
  container.replaceChildren(
    ...(transcript.length
      ? transcript.map((entry) =>
          el("p", { className: "transcript-entry" }, [el("span", { className: "transcript-kind" }, [`[${entry.kind}] `]), entry.text])
        )
      : [el("p", { className: "empty" }, ["No transcript yet."])])
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
