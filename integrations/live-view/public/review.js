// Plain JavaScript, no framework, no build step - same as app.js/task.js.
// The one page in this directory that writes anything: a tap on accept/
// fix/wrong POSTs to /api/review/tasks/<id>/verdict, sending an answer
// to a worker's clarifying questions POSTs to
// /api/review/tasks/<id>/answer, and stopping a running task (issue
// #203) POSTs to /api/review/tasks/<id>/stop - the server's only three
// non-GET routes (server.ts). Everything else here only ever polls
// /api/review, same 2-second cadence as the other list pages.
//
// `fetch` never sets a Tailscale identity header itself - a real one can
// only come from `tailscale serve` adding it while proxying this
// request in from the tailnet. Reached directly (e.g. from this same
// machine, bypassing Serve), every POST below gets back a 403 and the
// page shows the server's own explanation - there is nothing this
// script can do about that, by design (server.ts).

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

// Mirrors display.ts's noteToSend - duplicated here for the same reason
// stampClass above is. `undefined` means the POST leaves the `note` key
// off entirely, which is exactly what `fabrica verdict <id> accept` with
// no `-m` records.
function noteToSend(raw) {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// The one note box a card's verdict buttons all read (Client ruling):
// visible up front rather than revealed by a tap, optional for accept
// and wrong, required for fix - so one tap still records a verdict, with
// whatever happens to be typed attached as the note. Deliberately one
// box per card and not one per button: a second input would mean text
// typed in the visible box could be silently dropped by whichever button
// was tapped, on the one page in this directory that records decisions.
//
// `label` says which of those two it is for the buttons this card
// actually has. The id ties the label to the box for a screen reader;
// task ids are unique per page, so it can't collide.
function buildNoteBox(taskId, label) {
  const id = `note-${taskId}`;
  const labelEl = el("label", { className: "review-line", for: id }, [label]);
  const box = el(
    "textarea",
    {
      className: "review-note-box",
      id,
      rows: "2",
      placeholder: "Your note…",
    },
    []
  );
  return { labelEl, box };
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

async function postAnswer(taskId, answer) {
  const res = await fetch(`/api/review/tasks/${encodeURIComponent(taskId)}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answer }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `the server answered ${res.status}`);
  }
  return body;
}

async function postStop(taskId) {
  const res = await fetch(`/api/review/tasks/${encodeURIComponent(taskId)}/stop`, { method: "POST" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `the server answered ${res.status}`);
  }
  return body;
}

// Mirrors src/cli/render.ts's formatAge - the same compact age the list
// pages show, duplicated here for the same reason app.js's own copy is
// (a plain script with no build step can't import the tested .ts copy).
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

// A running task's card (issue #203): what it is, where, how long it has
// been going, what it has spent, and the worker's own last line - then
// one button, stop, behind one confirmation. There is deliberately no
// verdict here: a running task has produced nothing to rule on yet.
//
// The control exists only for a running task, because this list only
// ever holds running tasks (record-view.ts's getRunningRows) - that is
// the "hidden for a task that isn't running" half of the Client's
// ruling. The server refusing a stop for a non-running task anyway is
// the other half, and it is the one that matters when this page is a
// couple of seconds stale.
//
// `identified` is the other absence: reached without a Tailscale
// identity (directly on this machine, bypassing Serve), the button is
// not drawn at all, with one dim line saying why instead of a control
// that could only ever answer 403. The server still refuses such a POST
// on its own account - this is the page being honest, not the guard.
function buildRunningRow(row, identified) {
  const title = el("div", { className: "review-title" }, [row.title]);
  const whereBits = [row.project || "unknown project"];
  if (row.worker) whereBits.push(row.worker);
  const whereLine = el("div", { className: "review-line" }, [whereBits.join(" · ")]);
  const forLine = el("div", { className: "review-line" }, [`running ${formatAge(row.durationMs)} · ${row.costLabel}`]);
  const lastLine = el("div", { className: "review-line review-last-activity" }, [
    row.lastActivity ? `last: ${row.lastActivity}` : "no transcript yet",
  ]);

  const statusEl = el("div", { className: "review-status" }, [""]);
  const stopBtn = el("button", { className: "review-btn btn-wrong" }, ["Stop"]);

  stopBtn.addEventListener("click", async () => {
    if (!confirm("Stop this task? The worker's process is signaled and the task is closed as stopped.")) return;
    stopBtn.disabled = true;
    statusEl.textContent = "";
    try {
      const body = await postStop(row.id);
      // Optimistic, same as a recorded verdict below: the record already
      // says this task is stopped, so it is no longer running and the
      // next poll would drop it anyway. The one thing worth saying is
      // whether a live process was actually found to signal - a task
      // whose process had already exited is still stopped, and that is
      // not an error to hide.
      if (body.signaled === false) {
        statusEl.className = "review-status review-note";
        statusEl.textContent = "recorded as stopped - no running process was found to signal";
        stopBtn.remove();
        // Held on screen past the next poll (which would otherwise drop
        // this card two seconds later, taking the note with it): this is
        // the one outcome worth reading before it disappears. Gone on
        // the next page load, like any other notice here.
        cardEl.dataset.held = "1";
        return;
      }
      cardEl.remove();
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      stopBtn.disabled = false;
    }
  });

  const actions = identified
    ? el("div", { className: "review-actions" }, [stopBtn])
    : el("div", { className: "review-line review-note" }, ["stop needs a Tailscale identity - open this over the tailnet"]);
  const cardEl = el("div", { className: "review-card" }, [title, whereLine, forLine, lastLine, actions, statusEl]);
  return cardEl;
}

// The worker's quiz (issue #98): three questions about what the change
// did and why, each with its own answer hidden until the question is
// tapped. A native <details>/<summary>, not a click handler of our own:
// a tap opens it, so does Enter or Space from a keyboard, and a screen
// reader announces it as the expandable thing it is. Null for a task
// whose write-up predates the field - the record is append-only, so
// those were never backfilled, and an empty "Quiz" heading would only
// read as something missing.
//
// quiz.js carries the same two functions - duplicated, not shared, for
// the same reason formatAge above is: these are plain scripts with no
// build step and no module loading between them.
function buildQuizEntry(entry) {
  return el("details", { className: "quiz-entry" }, [
    el("summary", { className: "quiz-question" }, [entry.question]),
    el("div", { className: "quiz-answer" }, [entry.answer]),
  ]);
}

function buildQuiz(quiz) {
  if (!Array.isArray(quiz) || quiz.length === 0) return null;
  return el("div", { className: "quiz-list" }, quiz.map(buildQuizEntry));
}

// A label for the one-line reason shown on a "refused"/"failed" row -
// mirrors record-view.ts's own EarlyStopReviewRow doc comment: Inspector's
// own report for a refusal, whatever killed the task first for a failure.
function reasonLabel(kind) {
  return kind === "refused" ? "Inspector refused" : "Failed before any work started";
}

// A row sitting in "delivered" gets its full card - the write-up,
// Inspector's stamp, the gate's state, one note box and all three
// buttons. A row Inspector refused or that failed before any work started
// (never reaching a delivery at all - record-view.ts's `earlyStopKindOf`)
// gets a narrower card: the reason in plain words, the same note box, and
// the one verdict ("wrong") that can still close it - "accept"/"fix" have
// nothing to act on for either (no delivery to accept, no warm worker or
// line to fix).
function buildRow(row) {
  if (row.kind === "asking") return buildAskingRow(row);
  if (row.kind === "refused" || row.kind === "failed") return buildEarlyStopRow(row);
  return buildDeliveredRow(row);
}

// A task waiting on the Client's own words, not on a ruling: its
// questions as the worker asked them, numbered the same way `fabrica
// answer` numbers them in answers.md, and one box to answer all of them
// at once - which is exactly what `fabrica answer <id> -m "<text>"`
// takes too (one answer per round, not one per question).
function buildAskingRow(row) {
  const title = el("div", { className: "review-title" }, [row.title]);
  const questions = el(
    "ol",
    { className: "review-questions" },
    row.questions.map((question) => el("li", {}, [question]))
  );

  const box = el("textarea", {
    className: "review-answer",
    rows: "4",
    placeholder: "Your answer…",
    "aria-label": "Your answer",
  }, []);
  const statusEl = el("div", { className: "review-status" }, [""]);
  const sendBtn = el("button", { className: "review-btn btn-accept" }, ["Send answer"]);

  sendBtn.addEventListener("click", async () => {
    const answer = box.value.trim();
    if (answer.length === 0) {
      statusEl.textContent = "an answer needs actual text - it becomes part of the brief the worker receives";
      return;
    }
    sendBtn.disabled = true;
    box.disabled = true;
    statusEl.textContent = "";
    try {
      await postAnswer(row.id, answer);
      // Optimistic, same as a recorded verdict below: this task is now
      // running again, not waiting on anyone.
      cardEl.remove();
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      sendBtn.disabled = false;
      box.disabled = false;
    }
  });

  const actions = el("div", { className: "review-actions" }, [sendBtn]);
  const cardEl = el("div", { className: "review-card" }, [title, questions, box, actions, statusEl]);
  return cardEl;
}

function buildEarlyStopRow(row) {
  const title = el("div", { className: "review-title" }, [row.title]);
  const reasonLine = el("div", { className: "review-line review-reason" }, [`${reasonLabel(row.kind)}: ${row.reason}`]);
  // "wrong" is the only ruling this card offers, so the note is simply
  // optional here - nothing on it can ever require one.
  const { labelEl, box } = buildNoteBox(row.id, "Note (optional)");

  const statusEl = el("div", { className: "review-status" }, [""]);
  const wrongBtn = el("button", { className: "review-btn btn-wrong" }, ["Wrong"]);

  async function act(ruling, note) {
    wrongBtn.disabled = true;
    box.disabled = true;
    statusEl.textContent = "";
    try {
      await postVerdict(row.id, ruling, note);
      cardEl.remove();
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      wrongBtn.disabled = false;
      box.disabled = false;
    }
  }

  wrongBtn.addEventListener("click", () => {
    if (!confirm("Mark this wrong and close the task?")) return;
    act("wrong", noteToSend(box.value));
  });

  const actions = el("div", { className: "review-actions" }, [wrongBtn]);
  const cardEl = el("div", { className: "review-card" }, [title, reasonLine, labelEl, box, actions, statusEl]);
  return cardEl;
}

function buildDeliveredRow(row) {
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

  // One box, read by all three buttons below - optional for accept and
  // wrong, required for fix (see buildNoteBox).
  const { labelEl, box } = buildNoteBox(row.id, "Note (optional, required for a fix)");

  const statusEl = el("div", { className: "review-status" }, [""]);

  const acceptBtn = el("button", { className: "review-btn btn-accept" }, ["Accept"]);
  const fixBtn = el("button", { className: "review-btn btn-fix" }, ["Fix"]);
  const wrongBtn = el("button", { className: "review-btn btn-wrong" }, ["Wrong"]);
  const buttons = [acceptBtn, fixBtn, wrongBtn];

  function setBusy(busy) {
    for (const btn of buttons) btn.disabled = busy;
    box.disabled = busy;
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
    act("accept", noteToSend(box.value));
  });
  wrongBtn.addEventListener("click", () => {
    if (!confirm("Mark this wrong and close the task?")) return;
    act("wrong", noteToSend(box.value));
  });
  fixBtn.addEventListener("click", () => {
    const note = noteToSend(box.value);
    if (note === undefined) {
      // The same thing `fabrica verdict <id> fix` with no `-m` says, and
      // the same thing this page's own POST would come back with - said
      // here so an empty fix never costs a round trip.
      statusEl.textContent = 'a "fix" needs a note saying what to change';
      box.focus();
      return;
    }
    // A fix keeps a confirmation step, as it had when the note itself
    // arrived through a dialog: it reopens the line and spends real
    // money, so a mis-tap should not start a round.
    if (!confirm("Send this back for a fix with that note?")) return;
    act("fix", note);
  });

  const actions = el("div", { className: "review-actions" }, [acceptBtn, fixBtn, wrongBtn]);
  const body = [title, writeup];
  // Directly under the write-up, above the stamp: the quiz is the
  // worker explaining itself to the owner, so it belongs with the words,
  // not down among the machine's own verdicts.
  const quiz = buildQuiz(row.quiz);
  if (quiz) body.push(quiz);
  body.push(stampLine, gateLine);
  if (prLine) body.push(prLine);
  body.push(labelEl, box, actions, statusEl);
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

// The running list, rendered the same way renderRows does it: a card is
// built once per task and left alone while it is on screen, so a poll
// can never pull the ground out from under a half-made decision. A task
// that stops running - stopped here, stopped from the CLI, or simply
// finished - loses its card on the next poll.
function renderRunning(running, identified) {
  const section = document.getElementById("running-section");
  const container = document.getElementById("running");
  const countEl = document.getElementById("running-count");
  if (!section || !container || !countEl) return;

  const countText = String(running.length);
  if (countEl.textContent !== countText) countEl.textContent = countText;

  const incoming = new Set(running.map((r) => r.id));
  for (const child of Array.from(container.children)) {
    if (!incoming.has(child.dataset.taskId) && child.dataset.held !== "1") child.remove();
  }
  const known = new Set(Array.from(container.children).map((c) => c.dataset.taskId));

  for (const row of running) {
    if (known.has(row.id)) continue;
    const card = buildRunningRow(row, identified);
    card.dataset.taskId = row.id;
    container.appendChild(card);
  }

  // Computed last, from what is actually on screen rather than from the
  // incoming list: a held card (a stop whose process was already gone)
  // outlives its own row in `running`, and hiding the section would
  // take its one explanatory line with it.
  const hide = container.children.length === 0;
  if (section.hidden !== hide) section.hidden = hide;
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
  renderMeters(body.meters);
  renderRows(body.rows);
  renderRunning(body.running || [], body.identified === true);
}

// Issue #189's two subscription meters, one line in the toolbar. Set as
// text, never as markup, like everything else this page draws, and left
// blank when the server sent none - an older server answering a newer
// page must not leave "undefined" sitting on screen.
function renderMeters(meters) {
  const el = document.getElementById("meters");
  if (!el) return;
  if (!meters || typeof meters.label !== "string") {
    el.textContent = "";
    return;
  }
  const detail = typeof meters.detail === "string" && meters.detail !== "" ? ` · ${meters.detail}` : "";
  const text = `${meters.paused === true ? "PAUSED · " : ""}${meters.label}${detail}`;
  if (el.textContent !== text) el.textContent = text;
}

loadReview();
setInterval(loadReview, POLL_MS);
