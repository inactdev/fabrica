// Plain JavaScript, no framework, no build step - same as app.js/task.js.
// The one page in this directory that writes anything: a tap on accept/
// fix/wrong POSTs to /api/review/tasks/<id>/verdict, the server's one
// non-GET route (server.ts). Everything else here only ever polls
// /api/review, same 2-second cadence as the other list pages.
//
// `fetch` never sets a Tailscale identity header itself - a real one can
// only come from `tailscale serve` adding it while proxying this
// request in from the tailnet. Reached directly (e.g. from this same
// machine, bypassing Serve), every verdict POST below gets back a 403
// and the page shows the server's own explanation - there is nothing
// this script can do about that, by design (server.ts).

const POLL_MS = 2000;

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

// Mirrors record-view.ts's inspectorStampLabel output to a color class -
// duplicated here for the same reason app.js's own STATE_SYMBOL comment
// already explains: a plain script with no build step can't import the
// tested .ts copy.
function stampClass(stamp) {
  if (stamp === "green") return "stamp-green";
  if (stamp === "red") return "stamp-red";
  if (stamp === "refused") return "stamp-amber";
  return "stamp-gray";
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

async function postVerdict(taskId, ruling, note) {
  const res = await fetch(`/api/review/tasks/${encodeURIComponent(taskId)}/verdict`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(note === undefined ? { ruling } : { ruling, note }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `the server answered ${res.status}`);
  }
  return body;
}

// One row's whole DOM, plus a reference to its action buttons so they
// can be disabled while a verdict is in flight.
function buildRow(row) {
  const title = el("div", { className: "review-title" }, [row.title]);
  const writeup = el("div", { className: "review-writeup" }, [row.writeupBody]);
  const stampLine = el("div", { className: "review-line" }, [
    "Inspector: ",
    el("span", { className: `review-stamp ${stampClass(row.inspectorStamp)}` }, [row.inspectorStamp]),
    ...(row.inspectorDetail ? [` — ${row.inspectorDetail}`] : []),
  ]);
  const gateLine = el("div", { className: "review-line" }, [`Gate: ${row.gateState}`]);
  const prLine = row.prUrl
    ? el("div", { className: "review-line" }, [el("a", { href: row.prUrl, target: "_blank", rel: "noopener" }, [row.prUrl])])
    : null;

  const statusEl = el("div", { className: "review-status" }, [""]);

  const acceptBtn = el("button", { className: "review-btn btn-accept" }, ["Accept"]);
  const fixBtn = el("button", { className: "review-btn btn-fix" }, ["Fix…"]);
  const wrongBtn = el("button", { className: "review-btn btn-wrong" }, ["Wrong"]);
  const buttons = [acceptBtn, fixBtn, wrongBtn];

  function setBusy(busy) {
    for (const btn of buttons) btn.disabled = busy;
  }

  async function act(ruling, note) {
    setBusy(true);
    statusEl.textContent = "";
    try {
      await postVerdict(row.id, ruling, note);
      // Optimistic: this task is no longer waiting on a verdict - the
      // next poll would drop it anyway, but there's no reason to make
      // someone look at a row they just acted on for another 2 seconds.
      cardEl.remove();
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      setBusy(false);
    }
  }

  acceptBtn.addEventListener("click", () => {
    if (!confirm("Accept this delivery and close the task?")) return;
    act("accept");
  });
  wrongBtn.addEventListener("click", () => {
    if (!confirm("Mark this wrong and close the task?")) return;
    const note = prompt("One-line note (optional):", "");
    if (note === null) return;
    act("wrong", note.trim().length > 0 ? note.trim() : undefined);
  });
  fixBtn.addEventListener("click", () => {
    const note = prompt("What should the worker fix? (required, one line):", "");
    if (note === null) return;
    if (note.trim().length === 0) {
      statusEl.textContent = 'a "fix" needs a note saying what to change';
      return;
    }
    act("fix", note.trim());
  });

  const actions = el("div", { className: "review-actions" }, [acceptBtn, fixBtn, wrongBtn]);
  const body = [title, writeup, stampLine, gateLine];
  if (prLine) body.push(prLine);
  body.push(actions, statusEl);
  const cardEl = el("div", { className: "review-card" }, body);
  return cardEl;
}

function renderRows(rows) {
  const countEl = document.getElementById("count");
  const countText = String(rows.length);
  if (countEl.textContent !== countText) countEl.textContent = countText;

  const container = document.getElementById("rows");
  const known = new Set(Array.from(container.children).map((c) => c.dataset.taskId));
  const incoming = new Set(rows.map((r) => r.id));

  // A task no longer in the list (verdict recorded elsewhere, e.g. the
  // CLI, or a fix round that moved it back to "working") is removed -
  // but never one still mid-action here (its card was already removed
  // optimistically by `act` above the moment this page recorded it).
  for (const child of Array.from(container.children)) {
    if (!incoming.has(child.dataset.taskId)) child.remove();
  }

  if (rows.length === 0 && known.size === 0) {
    if (!container.querySelector(".empty")) {
      container.replaceChildren(el("p", { className: "empty" }, ["Nothing waiting on you."]));
    }
    return;
  }
  const existingEmpty = container.querySelector(".empty");
  if (existingEmpty) existingEmpty.remove();

  for (const row of rows) {
    if (known.has(row.id)) continue; // already on screen; this page doesn't live-update an open card
    const card = buildRow(row);
    card.dataset.taskId = row.id;
    container.appendChild(card);
  }
}

async function loadReview() {
  const res = await fetch("/api/review");
  if (!res.ok) return;
  const body = await res.json();
  if (body.error) {
    showError(body.error);
    return;
  }
  clearError();
  renderRows(body.rows);
}

loadReview();
setInterval(loadReview, POLL_MS);
