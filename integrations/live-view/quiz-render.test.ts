// The quiz, as the two pages that show it actually draw it (issue #98):
// three questions, each with its own answer hidden until the question is
// tapped. "Hidden until tapped" is a structural claim about the markup -
// a <details> whose <summary> is the question, with no `open` attribute
// on it - so it is checked structurally here, in the same fake DOM
// page-scripts.test.ts loads these pages into.
//
// Why this is its own file rather than more tests in page-scripts.test.ts:
// that file's whole mechanism is a `fetch` that NEVER settles, which is
// the state a just-loaded page is in and is what makes its load-order
// proof honest. These need the opposite - one answered poll - so they
// bring their own loader and their own globals rather than widening that
// one's.
//
// One render pass only, deliberately: the fake DOM's `dataset` is a
// snapshot rather than a live map (helpers/load-time-dom.ts), so the
// task-id keying both scripts use to leave a card alone across polls
// cannot be exercised here. What this file is about is the markup of one
// drawn card.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

import { FakeDocument, FakeElement, scriptTags, parseHtml } from "./helpers/load-time-dom.ts";

const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));

const QUIZ = [
  { question: "What did this change do?", answer: "Added a quiz to the write-up." },
  { question: "Why does it exist?", answer: "So the owner can check he understood it." },
  { question: "What should he watch?", answer: "That every delivery carries three questions." },
];

/** Loads a page the way a browser would - every script it names, in
 * document order, into one shared global scope - with `fetch` answering
 * each path from `answers` once, then flushes the microtasks that first
 * poll queued. */
async function render(file: string, pathname: string, answers: Record<string, unknown>): Promise<FakeDocument> {
  const html = readFileSync(join(PUBLIC_DIR, file), "utf8");
  const document = new FakeDocument(html);
  const requested: string[] = [];
  const context = createContext({
    document,
    location: { pathname, href: `http://127.0.0.1:7777${pathname}`, search: "", hash: "" },
    fetch: (path: string) => {
      requested.push(path);
      const body = answers[path];
      if (body === undefined) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    queueMicrotask,
    console,
    confirm: () => false,
    alert: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    scrollTo: () => {},
    requestAnimationFrame: () => 1,
    scrollY: 0,
    innerHeight: 900,
    innerWidth: 1400,
    pageYOffset: 0,
  });
  const window = runInContext("this", context) as Record<string, unknown>;
  window.window = window;
  window.self = window;

  for (const tag of scriptTags(parseHtml(html))) {
    if (tag.src === null) continue;
    const name = tag.src.slice(1);
    runInContext(readFileSync(join(PUBLIC_DIR, name), "utf8"), context, { filename: name });
  }

  // The page's own first poll is a chain of awaits; a few turns of the
  // microtask queue is all it needs to land.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(requested.length > 0, `${file} never fetched anything`);
  return document;
}

/** Every drawn quiz entry under `root`, as the three facts that matter:
 * the question, its answer, and whether it starts open. */
function entriesOf(document: FakeDocument): { question: string; answer: string; open: boolean; tag: string }[] {
  return document.querySelectorAll(".quiz-entry").map((entry: FakeElement) => {
    const summary = entry.querySelector("summary");
    const answer = entry.querySelector(".quiz-answer");
    assert.ok(summary instanceof FakeElement, "a quiz entry has no <summary> to tap");
    assert.ok(answer instanceof FakeElement, "a quiz entry has no answer");
    return {
      question: summary.textContent,
      answer: answer.textContent,
      open: entry.getAttribute("open") !== null,
      tag: entry.tagName,
    };
  });
}

test("the review page draws a delivered task's quiz with every answer closed until tapped", async () => {
  const document = await render("review.html", "/review", {
    "/api/review": {
      rows: [
        {
          id: "20261021-ship-it-aa",
          title: "Ship it",
          kind: "delivered",
          writeupBody: "## Context (Why)\n\nbecause",
          writeupOk: true,
          quiz: QUIZ,
          inspectorStamp: "green",
          inspectorDetail: null,
          gateState: "untouched",
          prUrl: null,
          lastActivityMs: Date.now(),
        },
      ],
      running: [],
      identified: true,
      meters: { label: "meters", paused: false, detail: "" },
    },
  });

  const entries = entriesOf(document);
  assert.deepEqual(
    entries.map((e) => e.question),
    QUIZ.map((q) => q.question)
  );
  assert.deepEqual(
    entries.map((e) => e.answer),
    QUIZ.map((q) => q.answer)
  );
  for (const entry of entries) {
    assert.equal(entry.tag, "DETAILS", "the question has to be the thing that opens the answer");
    assert.equal(entry.open, false, "an answer must start hidden, not shown");
  }
});

// A delivery whose write-up predates the field has no quiz at all. The
// card still has to draw - and with no empty "quiz" furniture on it,
// which would read as something missing rather than something that was
// never asked for.
test("the review page draws a delivered task with no quiz, and no empty quiz block", async () => {
  const document = await render("review.html", "/review", {
    "/api/review": {
      rows: [
        {
          id: "20261021-older-task-aa",
          title: "An older delivery",
          kind: "delivered",
          writeupBody: "## Context (Why)\n\nbecause",
          writeupOk: true,
          quiz: [],
          inspectorStamp: "green",
          inspectorDetail: null,
          gateState: "untouched",
          prUrl: null,
          lastActivityMs: Date.now(),
        },
      ],
      running: [],
      identified: true,
    },
  });

  assert.deepEqual(entriesOf(document), []);
  assert.equal(document.querySelectorAll(".quiz-list").length, 0);
  // The rest of the card is still there.
  assert.equal(document.querySelectorAll(".review-card").length, 1);
  assert.equal(document.querySelectorAll(".review-btn").length, 3);
});

/** One question as /api/quiz sends it. `standing`/`askable`/
 * `intervalLabel` are the server's own derivation (src/quiz/), so the
 * page is handed them rather than working them out. */
function apiQuestion(over: Record<string, unknown> = {}): Record<string, unknown> & { status: string; askable: boolean } {
  return {
    taskId: "20261021-newer-task-aa",
    index: 0,
    taskTitle: "Newer",
    question: QUIZ[0].question,
    answer: QUIZ[0].answer,
    acceptedAtMs: Date.UTC(2026, 9, 21, 12),
    status: "live",
    askable: true,
    rewritten: false,
    recheckNote: null,
    staleBecause: null,
    standing: { streak: 0, rightCount: 0, wrongCount: 0, lastAnsweredAtMs: null, dueAtMs: Date.UTC(2026, 9, 21, 12) },
    intervalLabel: "never asked",
    ...over,
  };
}

function quizBody(questions: ReturnType<typeof apiQuestion>[]): unknown {
  return {
    questions,
    counts: {
      total: questions.length,
      live: questions.filter((q) => q.status === "live").length,
      due: questions.filter((q) => q.askable).length,
      outdated: questions.filter((q) => q.status === "outdated").length,
      retired: questions.filter((q) => q.status === "retired").length,
    },
    now: Date.now(),
  };
}

test("the quiz page opens in review mode: one question, its answer hidden, and the list put away", async () => {
  const document = await render("quiz.html", "/quiz", {
    "/api/quiz": quizBody([apiQuestion({ index: 0 }), apiQuestion({ index: 1, question: QUIZ[1].question, answer: QUIZ[1].answer })]),
  });

  // Review mode is the visible one; the full list is the secondary view.
  assert.equal(document.getElementById("review")?.hidden, false);
  assert.equal(document.getElementById("list")?.hidden, true);
  assert.equal(document.getElementById("toggle")?.textContent, "All questions");

  // Exactly one question is being asked, and its answer is not on screen.
  const asked = document.querySelectorAll(".quiz-asked");
  assert.equal(asked.length, 1);
  assert.ok(QUIZ.map((q) => q.question).includes(asked[0].textContent));
  assert.equal(document.querySelectorAll(".quiz-answer-shown").length, 0, "the answer must not be shown before it is asked for");

  // The one control is the reveal - Right and Wrong only appear after it.
  const buttons = document.getElementById("review")?.querySelectorAll("button") ?? [];
  assert.deepEqual(
    buttons.map((b) => b.textContent),
    ["Show the answer"]
  );

  // The task that spawned the question and the date stay on the card.
  const origin = document.getElementById("review")?.querySelector(".review-line");
  assert.match(origin?.textContent ?? "", /from "Newer" · accepted 2026-10-21/);
});

test("the quiz page's list view carries every question, with the never-asked ones marked", async () => {
  const document = await render("quiz.html", "/quiz", {
    "/api/quiz": quizBody([
      apiQuestion({ index: 0 }),
      apiQuestion({
        index: 1,
        question: QUIZ[1].question,
        answer: QUIZ[1].answer,
        status: "outdated",
        askable: false,
        staleBecause: { touchedBy: "20261022-later-aa", files: ["a.ts"] },
      }),
      apiQuestion({
        index: 2,
        question: QUIZ[2].question,
        answer: QUIZ[2].answer,
        status: "retired",
        askable: false,
        recheckNote: "that code is gone",
      }),
    ]),
  });

  assert.equal(document.getElementById("count")?.textContent, "3");
  assert.match(document.getElementById("counts")?.textContent ?? "", /1 due of 1 asked · 1 may be outdated · 1 retired/);

  // Every question is on the list, and each answer is closed until it is
  // tapped - the one structural claim this page has always made.
  const entries = entriesOf(document);
  assert.deepEqual(
    entries.map((e) => e.question),
    QUIZ.map((q) => q.question)
  );
  for (const entry of entries) {
    assert.equal(entry.tag, "DETAILS", "the question has to be the thing that opens the answer");
    assert.equal(entry.open, false, "an answer must start hidden, not shown");
  }

  // The two that are never asked say which they are, and why.
  assert.deepEqual(
    document.getElementById("list")?.querySelectorAll(".quiz-status").map((s) => s.textContent),
    ["due", "may be outdated", "retired"]
  );
  const notes = document.getElementById("list")?.querySelectorAll(".quiz-note") ?? [];
  assert.match(notes[0].textContent, /may be outdated: 20261022-later-aa changed a\.ts/);
  assert.match(notes[1].textContent, /retired by a re-check: that code is gone/);
});

test("the quiz page says so plainly when nothing has been accepted yet", async () => {
  const document = await render("quiz.html", "/quiz", { "/api/quiz": quizBody([]) });

  assert.equal(document.getElementById("count")?.textContent, "0");
  const asked = document.querySelector(".quiz-asked");
  assert.ok(asked instanceof FakeElement, "review mode must say something rather than draw nothing");
  assert.match(asked.textContent, /Nothing due right now/);
  assert.match(document.getElementById("review")?.textContent ?? "", /No quizzes yet/);
  // Nothing to ask means nothing to offer either.
  assert.deepEqual(document.getElementById("review")?.querySelectorAll("button") ?? [], []);

  const empty = document.getElementById("list")?.querySelector(".empty");
  assert.ok(empty instanceof FakeElement, "an empty list view must say why it is empty");
  assert.match(empty.textContent, /No quizzes yet/);
});

test("nothing due, but questions exist: the page says when the next one is back and offers one anyway", async () => {
  const dueAtMs = Date.now() + 2 * 60 * 60 * 1000;
  const document = await render("quiz.html", "/quiz", {
    "/api/quiz": quizBody([
      apiQuestion({
        askable: false,
        intervalLabel: "2 right in a row - back in 2 days",
        standing: { streak: 2, rightCount: 2, wrongCount: 0, lastAnsweredAtMs: Date.now(), dueAtMs },
      }),
    ]),
  });

  const asked = document.querySelector(".quiz-asked");
  assert.match(asked?.textContent ?? "", /Nothing due right now/);
  assert.match(document.getElementById("review")?.textContent ?? "", /The next question is due in 2h/);
  assert.deepEqual(
    (document.getElementById("review")?.querySelectorAll("button") ?? []).map((b) => b.textContent),
    ["Ask one anyway"]
  );
});
