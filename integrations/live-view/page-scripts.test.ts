// Every page under public/ loaded the way a browser loads it: its scripts
// collected in document order and evaluated, in that order, into ONE
// shared global scope.
//
// The bug this exists to make impossible: banner.js is loaded first by all
// four pages with a plain `<script src>` tag, and it declared a top-level
// `const POLL_MS` - so do app.js, review.js and task.js. Classic scripts on
// one page share a single global lexical environment, and V8 runs the
// redeclaration check at script instantiation, before a statement of the
// second script's body executes. Every page therefore threw
// `SyntaxError: Identifier 'POLL_MS' has already been declared` and its own
// script never ran at all: four pages frozen on the placeholder markup in
// their own HTML, with the server answering every single request 200 and
// nothing wrong anywhere outside a browser console.
//
// `node:vm` reproduces those semantics exactly, which is the whole reason
// this test can be trusted: a context's global lexical environment is
// shared across `runInContext` calls, a top-level `const` in one script is
// readable from the next, a second `const` of the same name throws the real
// SyntaxError, and a repeated `function` declaration does not. The rules
// are V8's own, not a hand-written model of them (the distinction
// src/cli/skill-settings-live.test.ts draws for permission matching, for
// the same reason). The three self-checks at the bottom of this file pin
// that behaviour so a future runtime quietly losing it cannot leave these
// tests passing vacuously.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

import { FakeDocument, FakeElement, scriptTags, parseHtml } from "./helpers/load-time-dom.ts";

const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));

/**
 * The URL each page is served at. Not derivable from the filename, and it
 * matters: app.js branches on `location.pathname === "/history"` to pick
 * its endpoint and its empty-state wording, and task.js parses the task id
 * straight out of the path. Mirrors server.ts's own `STATIC_FILES` map and
 * its `TASK_PAGE_PATH` route.
 *
 * `everyPageIsRouted` below asserts this covers every *.html file actually
 * present in public/, so a new page cannot be silently skipped by a test
 * whose whole job is to cover all of them.
 */
const PAGE_PATHS: Record<string, string> = {
  "index.html": "/",
  "history.html": "/history",
  "review.html": "/review",
  "task.html": "/tasks/20260101-some-task-aa",
};

function htmlPages(): string[] {
  return readdirSync(PUBLIC_DIR)
    .filter((name) => name.endsWith(".html"))
    .sort();
}

/** Browser globals the four scripts reach for. Everything here is the
 * smallest thing that keeps load-time execution honest, not a convenience:
 *
 *  - `fetch` returns a promise that NEVER settles. All four scripts end by
 *    calling something that immediately awaits a fetch, so a pending
 *    request is exactly the state a just-loaded page is in. A stub that
 *    resolved would instead run every renderer against invented data and
 *    turn this into an unhandled-rejection generator - a different test
 *    from the one asked for.
 *  - `setInterval` is a no-op handle. A real timer would both keep the
 *    process alive and run a poll the pending fetch has not finished.
 */
function browserGlobals(pathname: string, document: FakeDocument) {
  let timerId = 0;
  const globals: Record<string, unknown> = {
    document,
    location: { pathname, href: `http://127.0.0.1:7777${pathname}`, search: "", hash: "" },
    fetch: () => new Promise(() => {}),
    setInterval: () => ++timerId,
    clearInterval: () => {},
    setTimeout: () => ++timerId,
    clearTimeout: () => {},
    queueMicrotask,
    console,
    confirm: () => false,
    alert: () => {},
    requestAnimationFrame: () => ++timerId,
    scrollTo: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    // A real page's scroll position. task.js reads these to decide whether
    // the transcript is pinned to the bottom.
    scrollY: 0,
    innerHeight: 900,
    innerWidth: 1400,
    pageYOffset: 0,
  };
  return globals;
}

interface LoadedPage {
  /** The vm context every one of the page's scripts was evaluated in. */
  context: object;
  /** The global object of that context - `window`, in browser terms. */
  window: Record<string, unknown>;
  document: FakeDocument;
  /** Script sources in the order they were evaluated, with the filename
   * each was reported under. */
  loaded: { name: string; source: string }[];
}

/**
 * Load one page: parse it, resolve its script tags against public/, and
 * evaluate each one in a single shared context, in document order.
 *
 * Throws whatever the browser would have thrown, with the offending
 * script's own filename on it.
 */
function loadPage(file: string): LoadedPage {
  const html = readFileSync(join(PUBLIC_DIR, file), "utf8");
  const pathname = PAGE_PATHS[file];
  assert.ok(pathname !== undefined, `${file} has no entry in PAGE_PATHS`);

  const document = new FakeDocument(html);
  const context = createContext(browserGlobals(pathname, document));
  const window = runInContext("this", context) as Record<string, unknown>;
  // `window`, `self` and `globalThis` all name the global object in a
  // browser, and task.js stashes state on `window.__lastTranscript`.
  window.window = window;
  window.self = window;

  const loaded: { name: string; source: string }[] = [];
  for (const tag of scriptTags(parseHtml(html))) {
    if (tag.src === null) {
      const source = tag.inline ?? "";
      if (source.trim() === "") continue;
      loaded.push({ name: `${file} (inline script ${loaded.length + 1})`, source });
      runInContext(source, context, { filename: `${file}#inline-${loaded.length}` });
      continue;
    }
    assert.ok(tag.src.startsWith("/"), `${file} references ${tag.src}, which is not a root-relative path`);
    const name = tag.src.slice(1);
    const source = readFileSync(join(PUBLIC_DIR, name), "utf8");
    loaded.push({ name, source });
    // The filename is what lands in the stack trace, so a failure names
    // the file a browser's console would have named.
    runInContext(source, context, { filename: name });
  }
  return { context, window, document, loaded };
}

// --- the guarantee ----------------------------------------------------

test("every HTML page in public/ is routed by this test", () => {
  assert.deepEqual(
    htmlPages(),
    Object.keys(PAGE_PATHS).sort(),
    "a page was added to or removed from public/ without updating PAGE_PATHS - " +
      "it would otherwise never be loaded by the tests below"
  );
});

for (const file of htmlPages()) {
  test(`${file}: every script it loads runs, in order, in one shared scope`, () => {
    const page = loadPage(file);
    assert.ok(page.loaded.length > 0, `${file} loads no scripts at all - did its script tags get dropped?`);
  });
}

// The specific thing that was broken. banner.js is the only script more
// than one page loads, so it is the only one that has to coexist with
// another - and the fix is that it declares nothing in the shared scope at
// all, rather than that it happens to pick names nobody else wants.
test("banner.js declares nothing in the global scope", () => {
  const html = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8");
  const document = new FakeDocument(html);
  const context = createContext(browserGlobals("/", document));
  const window = runInContext("this", context) as Record<string, unknown>;
  window.window = window;
  const before = new Set(Object.getOwnPropertyNames(window));

  const source = readFileSync(join(PUBLIC_DIR, "banner.js"), "utf8");
  runInContext(source, context, { filename: "banner.js" });

  // `var` and `function` declarations become own properties of the global
  // object...
  const added = Object.getOwnPropertyNames(window).filter((name) => !before.has(name));
  assert.deepEqual(added, [], `banner.js added global properties: ${added.join(", ")}`);

  // ...while `const`, `let` and `class` go into the global lexical
  // environment, where they are invisible as properties. Evaluating the
  // same script a second time in the same scope is what surfaces them:
  // a script that declares nothing is idempotent, one with a top-level
  // `const` throws the very SyntaxError this test exists to prevent.
  runInContext(source, context, { filename: "banner.js (second evaluation)" });
});

// --- self-checks on the mechanism -------------------------------------
//
// Everything above asserts that nothing throws, so it would pass just as
// happily against a runtime that had stopped enforcing redeclarations at
// all. These three prove the mechanism still has teeth.

test("vm: a shared context shares one global lexical scope, as a browser's page does", () => {
  const context = createContext({});
  runInContext("const SHARED = 7;", context, { filename: "first.js" });
  assert.equal(runInContext("SHARED", context, { filename: "second.js" }), 7);
});

test("vm: a second top-level const of the same name is the SyntaxError this test catches", () => {
  const context = createContext({});
  runInContext("const POLL_MS = 2000;", context, { filename: "banner.js" });
  assert.throws(
    () => runInContext("const POLL_MS = 2000;", context, { filename: "app.js" }),
    // Checked by name, not `instanceof SyntaxError`: a vm context is its
    // own realm, so the error it throws is built from that realm's
    // SyntaxError and `instanceof` is false across the boundary - for
    // `Error` too, not just the subclass.
    (error: unknown) => {
      const thrown = error as { name?: unknown; message?: unknown };
      return (
        thrown.name === "SyntaxError" &&
        typeof thrown.message === "string" &&
        /POLL_MS.*already been declared/.test(thrown.message)
      );
    },
    "two classic scripts redeclaring a top-level const must throw - without this, the tests above prove nothing"
  );
});

test("vm: a repeated function declaration does not throw, exactly as in a browser", () => {
  const context = createContext({});
  runInContext("function el() {}", context, { filename: "banner.js" });
  runInContext("function el() {}", context, { filename: "app.js" });
});

// --- the fake DOM has to be good enough to be load-bearing ------------
//
// task.html is the one page that does real synchronous DOM work while its
// scripts load (it wires its filter buttons and its tail toggle at the top
// level). If the fake answered those lookups with nothing, task.js's
// top-level block would quietly do nothing and the load test above would
// pass without having exercised anything.

test("task.html: the page's load-time DOM wiring really happened", () => {
  const page = loadPage("task.html");
  const filterButtons = page.document.querySelectorAll(".filters .filter-btn[data-filter]");
  assert.ok(filterButtons.length >= 4, "expected task.html's filter buttons to be found");
  for (const button of filterButtons) {
    assert.ok(
      (button.listeners.get("click") ?? []).length > 0,
      `${button.getAttribute("data-filter")} got no click handler`
    );
  }
  const tail = page.document.getElementById("tail-toggle");
  assert.ok(tail instanceof FakeElement, "task.html has no #tail-toggle");
  // setTail(true) ran: the label is written and the button marked active.
  assert.equal(tail.textContent, "Tail: on");
  assert.ok(tail.classList.contains("active"));
  assert.ok((tail.listeners.get("click") ?? []).length > 0, "#tail-toggle got no click handler");
});

test("load-time DOM: an unsupported selector fails loudly rather than matching nothing", () => {
  const document = new FakeDocument("<html><body><div id='a'></div></body></html>");
  assert.throws(
    () => document.querySelectorAll("div > span"),
    /does not implement the selector/,
    "a fake that silently matched nothing would hide a real gap"
  );
});
