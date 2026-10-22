// Plain JavaScript, no framework, no build step - same as app.js/
// review.js/task.js. The /quiz page: every accepted task's quiz
// questions, with a review mode that asks one at a time.
//
// Two views, one page. Review mode is what it opens in (Client ruling):
// one question, its answer hidden until asked for, then Right or Wrong,
// which POSTs to /api/quiz/answer. The full list is behind the toolbar
// toggle, and shows every question there is - including the ones that
// are never asked, each marked with why, because hiding those would hide
// what changed.
//
// Nothing about the quiz is remembered in the browser. Every mark goes
// to the record and comes back on the next poll; which question may be
// asked, and when it is next due, are both computed server-side
// (src/quiz/), so this file holds no copy of the repetition rule to
// drift from the tested one. The only state here is which question is on
// screen and whether its answer has been revealed - two facts about this
// tab, not about the quiz.
//
// Each answer in the list view is hidden behind a native
// <details>/<summary> pair rather than a click handler of our own: a tap
// opens it, so do Enter and Space from a keyboard, and a screen reader
// announces it as the expandable thing it is - none of which a div with
// an onclick gets for free. Review mode reveals its answer with a button
// instead, because there the reveal is a step in a sequence that ends in
// a mark, not a disclosure the Client browses at will.

const POLL_MS = 2000;

function el(tag, props, children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (key === "className") node.className = value;
    else if (key === "onclick") node.addEventListener("click", value);
    else node.setAttribute(key, value);
  }
  for (const child of children || []) {
    if (child === null || child === undefined) continue;
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

/** The calendar date a task was accepted on, which stays on every card
 * next to the task it came from. ISO rather than a localized phrase:
 * unambiguous, and it sorts the way it reads. */
function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A question's identity: its task plus its position in that task's
 * quiz. Stable across a re-check that rewrites its words, which is
 * exactly why the server keys it this way too. */
function keyOf(question) {
  return `${question.taskId}#${question.index}`;
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

async function postQuizAnswer(taskId, index, right) {
  const res = await fetch("/api/quiz/answer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId, index, right }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `the server answered ${res.status}`);
  return body;
}

// Everything this tab knows. `questions`/`counts`/`serverNow` are the
// server's last answer; the five below them are this tab's own view
// state and nothing else's.
let questions = [];
let counts = { total: 0, live: 0, due: 0, outdated: 0, retired: 0 };
let serverNow = 0;
let mode = "review";
/** Which question is on screen, by key - held across polls so a poll can
 * never swap the question out from under a tap. */
let currentKey = null;
/** The one question "Ask one anyway" put on screen even though nothing
 * was due, so a later poll doesn't drop it for not being askable. */
let anywayKey = null;
let revealed = false;
/** What just happened, shown above the next question until that one is
 * answered too. */
let notice = null;

/** What the review card was last built from, so an ordinary poll - which
 * changes none of it - leaves the card, and any focus inside it, alone. */
let rendered = { key: undefined, revealed: undefined, notice: undefined, empty: undefined };

function questionByKey(key) {
  const found = questions.filter((question) => keyOf(question) === key);
  return found.length > 0 ? found[0] : null;
}

/** A random question from the ones the server says may be asked now.
 * Random, not round-robin: the Client asked to be asked a random
 * question, and the schedule has already decided which ones are even in
 * the hat. */
function pickAskable() {
  const askable = questions.filter((question) => question.askable);
  if (askable.length === 0) return null;
  return askable[Math.floor(Math.random() * askable.length)];
}

/** The live question coming back soonest - what the "nothing due" panel
 * names, and what "Ask one anyway" reaches for. */
function soonestLive() {
  const live = questions.filter((question) => question.status === "live");
  if (live.length === 0) return null;
  return live.reduce((best, question) => (question.standing.dueAtMs < best.standing.dueAtMs ? question : best));
}

function statusLabel(question) {
  if (question.status === "retired") return { text: "retired", cls: "quiz-status status-retired" };
  if (question.status === "outdated") return { text: "may be outdated", cls: "quiz-status status-outdated" };
  if (question.askable) return { text: "due", cls: "quiz-status status-due" };
  return { text: "asked later", cls: "quiz-status status-live" };
}

/** The "which change was this about" line every card carries, in both
 * views - the task that spawned the question and the date it was
 * accepted, which stay visible wherever a question is shown. */
function buildOriginLine(question) {
  return el("div", { className: "review-line" }, [
    `from "${question.taskTitle}" · accepted ${isoDate(question.acceptedAtMs)} · `,
    el("a", { href: `/tasks/${encodeURIComponent(question.taskId)}` }, ["open the task"]),
  ]);
}

/** Why a question is not being asked, when that is the case - the later
 * task that dated it, or the re-check round's own reason for retiring or
 * rewriting it. */
function buildStandingNotes(question) {
  const notes = [];
  if (question.staleBecause) {
    notes.push(
      el("div", { className: "quiz-note" }, [
        `may be outdated: ${question.staleBecause.touchedBy} changed ${question.staleBecause.files.join(", ")}. ` +
          `Not asked until a re-check round has looked at it.`,
      ])
    );
  }
  if (question.status === "retired") {
    notes.push(
      el("div", { className: "quiz-note" }, [
        `retired by a re-check${question.recheckNote ? `: ${question.recheckNote}` : ""}.`,
      ])
    );
  } else if (question.rewritten) {
    notes.push(
      el("div", { className: "quiz-note" }, [
        `rewritten by a re-check${question.recheckNote ? `: ${question.recheckNote}` : ""} - ` +
          `these are not the words the task's own worker wrote.`,
      ])
    );
  }
  return notes;
}

async function mark(question, right) {
  try {
    await postQuizAnswer(question.taskId, question.index, right);
    clearError();
    notice = right
      ? "Marked right - it comes back later, and later again each time."
      : "Marked wrong - it comes back next session.";
    currentKey = null;
    anywayKey = null;
    revealed = false;
    await loadQuiz();
  } catch (err) {
    showError(err.message);
  }
}

function buildReviewCard(question) {
  const children = [el("div", { className: "quiz-asked" }, [question.question]), buildOriginLine(question)];

  if (revealed) {
    children.push(el("div", { className: "quiz-answer quiz-answer-shown" }, [question.answer]));
    children.push(
      el("div", { className: "review-actions" }, [
        el("button", { className: "review-btn btn-accept", onclick: () => mark(question, true) }, ["Right"]),
        el("button", { className: "review-btn btn-wrong", onclick: () => mark(question, false) }, ["Wrong"]),
      ])
    );
  } else {
    children.push(
      el("div", { className: "review-actions" }, [
        el(
          "button",
          {
            className: "review-btn btn-fix",
            onclick: () => {
              revealed = true;
              render();
            },
          },
          ["Show the answer"]
        ),
      ])
    );
  }

  children.push(el("div", { className: "review-line" }, [question.intervalLabel]));
  return el("div", { className: "review-card" }, children);
}

function buildNothingDueCard() {
  const next = soonestLive();
  const children = [
    el("div", { className: "quiz-asked" }, ["Nothing due right now."]),
    el("div", { className: "review-line" }, [
      next === null
        ? counts.total === 0
          ? "No quizzes yet - an accepted task's three questions show up here."
          : "Every question is either answered recently, marked as possibly outdated, or retired."
        : `The next question is due in ${formatAge(Math.max(0, next.standing.dueAtMs - serverNow))}.`,
    ]),
  ];
  if (next !== null) {
    children.push(
      el("div", { className: "review-actions" }, [
        el(
          "button",
          {
            className: "review-btn btn-fix",
            onclick: () => {
              // Deliberately a question that is NOT due: the schedule
              // exists to space out revision, not to lock the Client out
              // of his own quiz when he wants another one. The mark it
              // earns counts exactly like any other.
              anywayKey = keyOf(next);
              currentKey = anywayKey;
              revealed = false;
              render();
            },
          },
          ["Ask one anyway"]
        ),
      ])
    );
  }
  return el("div", { className: "review-card" }, children);
}

function renderReview() {
  // Drop the question on screen once it has genuinely gone - answered
  // (so no longer due), retired by a re-check, or dated by a later
  // accept. The one deliberately kept is the "ask anyway" question,
  // which was never due in the first place.
  const held = currentKey === null ? null : questionByKey(currentKey);
  if (held === null || (!held.askable && currentKey !== anywayKey)) {
    currentKey = null;
    anywayKey = null;
    revealed = false;
  }
  if (currentKey === null) {
    const picked = pickAskable();
    currentKey = picked === null ? null : keyOf(picked);
  }

  const question = currentKey === null ? null : questionByKey(currentKey);
  const empty = question === null;
  // An ordinary poll changes none of these, so the card - and whatever
  // the Client is pointing at inside it - is left exactly as it is.
  if (rendered.key === currentKey && rendered.revealed === revealed && rendered.notice === notice && rendered.empty === empty) {
    return;
  }
  rendered = { key: currentKey, revealed: revealed, notice: notice, empty: empty };

  const container = document.getElementById("review");
  const children = [];
  if (notice !== null) children.push(el("div", { className: "quiz-notice" }, [notice]));
  children.push(empty ? buildNothingDueCard() : buildReviewCard(question));
  container.replaceChildren(...children);
}

function buildListCard(question) {
  const status = statusLabel(question);
  const card = el("div", { className: "review-card" }, [
    el("details", { className: "quiz-entry" }, [
      el("summary", { className: "quiz-question" }, [question.question]),
      el("div", { className: "quiz-answer" }, [question.answer]),
    ]),
    el("div", { className: "quiz-meta" }, [
      el("span", { className: status.cls }, [status.text]),
      el("span", { className: "quiz-interval" }, [question.intervalLabel]),
    ]),
    buildOriginLine(question),
  ]);
  for (const note of buildStandingNotes(question)) card.appendChild(note);
  card.setAttribute("data-key", keyOf(question));
  return card;
}

// Keyed by question and built once, the same way review.js renders its
// own list - so a poll can never close an answer the owner just opened.
// Only the two parts that really do change on a poll, the status badge
// and the interval phrase, are written through in place.
function renderList() {
  const container = document.getElementById("list");
  const incoming = new Set(questions.map(keyOf));
  for (const child of Array.from(container.children)) {
    const key = child.dataset.key;
    if (key !== undefined && !incoming.has(key)) child.remove();
  }

  if (questions.length === 0) {
    if (!container.querySelector(".empty")) {
      container.replaceChildren(
        el("p", { className: "empty" }, ["No quizzes yet - an accepted task's three questions show up here."])
      );
    }
    return;
  }
  const emptyEl = container.querySelector(".empty");
  if (emptyEl) emptyEl.remove();

  const existing = new Map(Array.from(container.children).map((child) => [child.dataset.key, child]));
  // The server sends them newest-acceptance-first; appending in that
  // order and only ever adding what is missing keeps a card that is
  // already on screen exactly where it was.
  for (const question of questions) {
    const card = existing.get(keyOf(question));
    if (card === undefined) {
      container.appendChild(buildListCard(question));
      continue;
    }
    const status = statusLabel(question);
    const badge = card.querySelector(".quiz-status");
    if (badge && (badge.textContent !== status.text || badge.className !== status.cls)) {
      badge.className = status.cls;
      badge.textContent = status.text;
    }
    const interval = card.querySelector(".quiz-interval");
    if (interval && interval.textContent !== question.intervalLabel) interval.textContent = question.intervalLabel;
  }
}

function renderCounts() {
  const countEl = document.getElementById("count");
  const countText = String(counts.total);
  if (countEl.textContent !== countText) countEl.textContent = countText;

  const parts = [`${counts.due} due of ${counts.live} asked`];
  if (counts.outdated > 0) parts.push(`${counts.outdated} may be outdated`);
  if (counts.retired > 0) parts.push(`${counts.retired} retired`);
  const text = parts.join(" · ");
  const countsEl = document.getElementById("counts");
  if (countsEl.textContent !== text) countsEl.textContent = text;
}

function render() {
  renderCounts();
  renderReview();
  renderList();
}

function applyMode() {
  document.getElementById("review").hidden = mode !== "review";
  document.getElementById("list").hidden = mode !== "list";
  document.getElementById("toggle").textContent = mode === "review" ? "All questions" : "Review";
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
  questions = body.questions || [];
  counts = body.counts || { total: questions.length, live: 0, due: 0, outdated: 0, retired: 0 };
  serverNow = body.now || Date.now();
  render();
}

document.getElementById("toggle").addEventListener("click", () => {
  mode = mode === "review" ? "list" : "review";
  applyMode();
});

applyMode();
loadQuiz();
setInterval(loadQuiz, POLL_MS);
