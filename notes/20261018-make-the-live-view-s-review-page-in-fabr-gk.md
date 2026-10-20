# The live view's `/review` note box: one per card, empty means no note

Task: "make the live view's /review page offer an optional note on
accept and wrong, the same box fix already shows but not required,
sending it as the verdict note exactly like `fabrica verdict -m`; the
note is the Client's labeled reaction and feeds the record."

## What was already true, and why nothing under `src/` changed

`POST /api/review/tasks/<id>/verdict` has always accepted an optional
`note` for *any* ruling and handed it straight to the same
`recordVerdictDecision` `fabrica verdict` calls, which already records a
note for `accept`/`wrong` in both places a `-m` note lands - the task's
`verdict` file and the `verdict-recorded` event
(`src/foreman/verdict.ts`). The gap was entirely in the browser: the
page simply never offered anywhere to type one for `accept`, and
collected `fix`/`wrong` notes through a `window.prompt()` dialog. So
this was a `public/review.js` + `display.ts` change with no new write
path anywhere, and the server route was left alone.

## The settled shape (Client ruling, clarified on this task)

- The box is **visible up front**, not revealed by a tap. One tap still
  records the verdict, with whatever happens to be typed attached.
- **One box per card, read by every verdict button on it** - optional
  for `accept`/`wrong`, required for `fix`. The alternative (keep `fix`
  on its `prompt()`, add an up-front box only for accept/wrong) was
  rejected: two note inputs on one card means text typed in the visible
  box gets silently dropped by whichever button is tapped, which is the
  worst possible failure on the one page in this directory that records
  decisions.
- **An empty box sends no note at all** - the `note` key is left off the
  request body entirely, so the record reads exactly as
  `fabrica verdict <id> accept` with no `-m`, never an empty note
  recorded as the Client's reaction. Whitespace-only counts as empty.
  That one rule is `display.ts`'s `noteToSend`, unit tested there and
  hand-duplicated in `review.js` - the same pattern every other function
  in `display.ts` already follows, since a build-stepless browser script
  can't import across the `.ts` boundary.
- **`prompt()` is gone from `review.js` entirely.** Nothing on this page
  opens a browser dialog for text any more; the only dialogs left are
  the `confirm()` guards.
- **All three verdict buttons keep one `confirm()`.** `accept`/`wrong`
  already had one; `fix` had the `prompt()` itself as its second step, so
  it got a `confirm()` in its place rather than becoming the one verdict
  that fires on a single unguarded tap. Removing a mis-tap guard on a
  phone, on an action that closes a task or spends money on a round, was
  not what "one click still submits" asked for.
- The **Fix** button lost its ellipsis (`Fix…` → `Fix`): the ellipsis
  meant "this opens a dialog", and it no longer does.

## Sharp edge worth knowing

Typed text surviving the page's 2-second poll is not a new mechanism -
it rests on `renderRows`' existing rule that a card's DOM node is built
once and left alone for as long as that task is on screen. Anything that
ever makes this page live-update an open card would silently start
wiping half-typed notes.

## Testing note

`display.test.ts` covers `noteToSend` directly. `server.test.ts` gained
three cases pinning the plumbing the page now leans on: an `accept` with
a note, an `accept` with no note at all (the empty-box case - asserting
`note: ""` on the event and a bare `accept` line in the `verdict` file),
and a `wrong` with a note. `review.js` itself has no test harness, the
same as `app.js`/`task.js`.
