# Two classic scripts, one global scope: the live view's pages

## The bug

`integrations/live-view/public/banner.js` is loaded by all four pages with
a plain `<script src>` tag, first, before each page's own script. It
declared `const POLL_MS = 2000;` at the top level — and so do `app.js`,
`review.js` and `task.js`, each also a plain classic script.

Classic scripts on one page share **one** global lexical environment.
`const`/`let`/`class` at the top level of a classic script go into that
shared environment, not onto `window`, and V8 performs the redeclaration
check at script *instantiation* — before a single statement of the second
script's body runs. So the second script threw
`SyntaxError: Identifier 'POLL_MS' has already been declared` and never
executed at all.

Why it looked healthy: the banner script itself ran fine (it is first), the
server answered every request with a 200, and the failure lives entirely in
the browser's console. Every page therefore sat on the placeholder markup
baked into its own HTML — `Tasks · 0`, `Loading…`, an empty task list —
with no error anywhere in the record, the server log, or the network tab.

## The fix

`banner.js` is wrapped in an IIFE, so it declares nothing in the shared
scope. It never needed to: its own header already says it is deliberately
self-contained, and nothing in `app.js`/`review.js`/`task.js` reads any of
its names.

## The guard, and why it is shaped this way

`integrations/live-view/page-scripts.test.ts` loads each page the way a
browser does: parse the HTML, collect its `<script>` tags in document
order, then evaluate each one in **one shared `node:vm` context**. A `vm`
context reproduces the browser's semantics exactly — verified here, not
assumed: a top-level `const` declared by script A is readable by script B,
a second `const` of the same name throws the real
`SyntaxError: Identifier 'x' has already been declared`, and a repeated
`function` declaration does not. That means V8 itself, not a hand-written
model of the rules, is what decides whether two of these scripts can
coexist.

Two sharp edges that shape the test:

- **`fetch` must never settle.** All four scripts end with a call that
  immediately awaits `fetch`, plus a `setInterval`. A `fetch` that returns
  `new Promise(() => {})` models "the page has loaded, requests are in
  flight" precisely, and keeps the test to the synchronous load-time
  behaviour it is about — a resolving stub would instead drag every
  renderer into scope and turn a load test into an unhandled-rejection
  generator.
- **A page's URL is not derivable from its filename.** `app.js` branches on
  `location.pathname === "/history"` and `task.js` parses the task id out
  of it, so the test needs `index.html` → `/`, `task.html` →
  `/tasks/<id>`, and so on (server.ts's own `STATIC_FILES` plus
  `TASK_PAGE_PATH`). The map is written out in the test, with an assertion
  that every `*.html` file actually present in `public/` appears in it — a
  new page added without a route entry fails loudly instead of being
  silently skipped.

The fix was also confirmed against a real server rather than only in the
test: a scratch harness started `startLiveView` on an empty record home,
fetched `/`, `/history` and `/review` plus their scripts over HTTP, and
loaded them with a *real* `fetch` pointed back at that server. Before the
fix the page's own script died on the SyntaxError; after it, all three
render — `Today: $0.00 (no daily cap set)` in place of the `Loading…`
placeholder, and each page's own empty-state wording (`No open tasks.` /
`No finished tasks yet.` / `Nothing waiting on you.`) in place of an empty
list. That is the exact symptom pair, observed rather than reasoned about.

`helpers/load-time-dom.ts` is the DOM those scripts load against. It is a
load-time-only DOM on purpose: enough to run what a page does
synchronously (`getElementById`, a real descendant/compound
`querySelectorAll`, `classList`, `dataset`, `textContent`, node building),
and no more. Following this project's rule that a fake must never drift
quietly, its `querySelectorAll` **throws** on selector syntax it does not
implement rather than returning an empty list — an unsupported selector
must read as "extend the fake", never as "nothing matched".

## Where else this shape could occur

Only `banner.js` is shared: `index.html`/`history.html` load `app.js`,
`review.html` loads `review.js`, `task.html` loads `task.js`, and no page
loads two of those three. So the three page scripts' own identical
`const POLL_MS` lines are not a collision and were left exactly as they
are. The new test covers every page, so a fifth page, or a second shared
script, is checked the moment it is added.
