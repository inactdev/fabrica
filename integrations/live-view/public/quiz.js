// Plain JavaScript, no framework, no build step - same as app.js/
// review.js/task.js. The /quiz page (issue #98): the last ten accepted
// tasks' quizzes, newest acceptance first, for the owner to revisit.
//
// Read-only, like every page here except /review: it polls /api/quiz and
// draws what comes back. There is nothing to decide on a task that was
// already accepted, so this page has no buttons and sends no requests.
//
// Each question hides its own answer until it is tapped, using a native
// <details>/<summary> pair rather than a click handler of our own: a tap
// opens it, so does Enter or Space from a keyboard, and a screen reader
// announces it as the expandable thing it is - none of which a div with
// an onclick gets for free.

const POLL_MS = 2000;

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

// Mirrors src/cli/render.ts's formatAge - duplicated here for the same
// reason app.js's own copy is (a plain script with no build step can't
// import the tested .ts copy).
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

// One question, its answer hidden until the question is tapped. Exported
// shape-wise to review.js by duplication, not by import: the two pages
// load different scripts, and this is six lines (review.js's own copy
// carries the same comment).
function buildQuizEntry(entry) {
  return el("details", { className: "quiz-entry" }, [
    el("summary", { className: "quiz-question" }, [entry.question]),
    el("div", { className: "quiz-answer" }, [entry.answer]),
  ]);
}

function buildQuiz(quiz) {
  return el("div", { className: "quiz-list" }, quiz.map(buildQuizEntry));
}

function buildRow(row) {
  const title = el("div", { className: "review-title" }, [row.title]);
  const when = el("div", { className: "review-line" }, [`accepted ${formatAge(Date.now() - row.acceptedAtMs)} ago`]);
  const link = el("div", { className: "review-line" }, [
    el("a", { href: `/tasks/${encodeURIComponent(row.id)}` }, ["open the task"]),
  ]);
  return el("div", { className: "review-card" }, [title, when, buildQuiz(row.quiz), link]);
}

// Keyed by task id and built once, the same way review.js renders its
// own list - so a poll can never close an answer the owner just opened.
// A card only ever leaves because its task fell off the end of the last
// ten.
//
// The rows arrive newest-acceptance-first, and a card that is new is
// always the newest one (a task is accepted once), so new cards go in at
// the TOP - iterating in reverse and inserting before whatever is
// currently first puts both a cold first load and a single later arrival
// in the right order, without ever moving a card that is already on
// screen.
function renderRows(rows) {
  const countEl = document.getElementById("count");
  const countText = String(rows.length);
  if (countEl.textContent !== countText) countEl.textContent = countText;

  const container = document.getElementById("rows");
  const incoming = new Set(rows.map((r) => r.id));
  for (const child of Array.from(container.children)) {
    if (child.dataset.taskId !== undefined && !incoming.has(child.dataset.taskId)) child.remove();
  }
  const known = new Set(Array.from(container.children).map((c) => c.dataset.taskId));

  if (rows.length === 0) {
    if (!container.querySelector(".empty")) {
      container.replaceChildren(
        el("p", { className: "empty" }, ["No quizzes yet - an accepted task's three questions show up here."])
      );
    }
    return;
  }
  const existingEmpty = container.querySelector(".empty");
  if (existingEmpty) existingEmpty.remove();

  for (const row of [...rows].reverse()) {
    if (known.has(row.id)) continue;
    const card = buildRow(row);
    card.dataset.taskId = row.id;
    container.insertBefore(card, container.firstChild);
  }
}

async function loadQuiz() {
  const res = await fetch("/api/quiz");
  if (!res.ok) return;
  const body = await res.json();
  if (body.error) {
    showError(body.error);
    return;
  }
  clearError();
  renderRows(body.rows || []);
}

loadQuiz();
setInterval(loadQuiz, POLL_MS);
