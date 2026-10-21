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

test("the quiz page draws one card per accepted task, closed, with its count", async () => {
  const document = await render("quiz.html", "/quiz", {
    "/api/quiz": {
      rows: [
        { id: "20261021-newer-task-aa", title: "Newer", quiz: QUIZ, acceptedAtMs: Date.now() - 60_000 },
        { id: "20261021-older-task-bb", title: "Older", quiz: QUIZ, acceptedAtMs: Date.now() - 7_200_000 },
      ],
    },
  });

  const cards = document.querySelectorAll(".review-card");
  assert.equal(cards.length, 2);
  // Newest acceptance first, the order the server sent them in.
  assert.equal(cards[0].querySelector(".review-title")?.textContent, "Newer");
  assert.equal(cards[1].querySelector(".review-title")?.textContent, "Older");
  assert.equal(document.getElementById("count")?.textContent, "2");

  const entries = entriesOf(document);
  assert.equal(entries.length, 6, "both cards' three questions");
  for (const entry of entries) assert.equal(entry.open, false);

  // Nothing on this page records anything - it is a page for revisiting
  // a ruling that was already made.
  assert.equal(document.querySelectorAll("button").length, 0);
});

test("the quiz page says so plainly when nothing has been accepted yet", async () => {
  const document = await render("quiz.html", "/quiz", { "/api/quiz": { rows: [] } });

  const empty = document.querySelector(".empty");
  assert.ok(empty instanceof FakeElement, "an empty quiz page must say why it is empty");
  assert.match(empty.textContent, /No quizzes yet/);
  assert.equal(document.getElementById("count")?.textContent, "0");
});
