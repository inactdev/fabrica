# `fabrica log` renders an event's detail over as many lines as it needs

Issue #169. `fabrica log` used to be strictly one line per event, and
`src/cli/render.ts`'s `fallbackDetail` capped every rendered detail at a
flat 200 characters with a trailing `…`. The combination cut real
failure messages off mid-word and hid the cause the Client opened the log
to read — the reported case was a `task-failed` whose whole reason was a
`git worktree add` error, shown as `… checking out 'fabric…`.

## What the rendering guarantees now

- **`formatEventLines(events, opts)` returns one array element per
  output line**, not per event. An event whose detail wraps contributes
  several, so `log-command.ts` keeps printing one line at a time without
  knowing. `formatEventLine(event, opts)` is the single-event form and
  returns those lines newline-joined; `formatEventBlock` (module-private)
  is where both come from.
- Continuation lines are indented by `DETAIL_CONTINUATION_INDENT` (four
  spaces), so the timestamp column still scans down the left edge and a
  four-line event reads as one event.
- `DETAIL_CHAR_LIMIT` (10,000, exported) is the one ceiling, applied in
  `formatEventBlock` to **every** renderer's output rather than only to
  the JSON fallback. When it bites it appends
  `[shortened: N of M characters shown]` on its own line — never a bare
  ellipsis, because a reader who can't tell "the message ended" from "the
  message was cut" is back in the original bug.
- **Soft wrapping only happens when there is a real terminal to wrap
  to.** `log-command.ts`'s `detectWrapWidth()` reads
  `process.stdout.columns` only when `process.stdout.isTTY`, and the
  command skips detection entirely when the caller supplied its own
  `stdout` (every test, and any programmatic caller). A piped, redirected
  or captured `fabrica log` is therefore unwrapped and reproducible —
  output that silently depends on how wide the window happened to be is
  output no script can rely on, and it would have made
  `log-command.test.ts` flaky depending on whether the test runner had a
  TTY. Tests drive the wrapped path through `wrapWidth` directly.
- `wrapDetail(text, firstWidth, restWidth)` is the wrapper: breaks at
  whitespace, hard at the margin for a token wider than the whole line (a
  URL, a path), keeps newlines already in the text, and floors each
  segment at `MIN_WRAP_SEGMENT` (24) so an absurdly narrow window can't
  shred the message — on a window that narrow the timestamp and event
  name overflow it on their own anyway.

## What was un-truncated, and what deliberately was not

Un-truncated in `fabrica log`: `task-failed` (which had **no** renderer
at all and fell through to JSON, so its reason showed as an escaped
string with literal `\n`s in it — it now has one, shaped exactly like
`cap-refused`'s) and `check-run`'s `notVerified` reason (was
`.split("\n")[0]`).

Left as a first line or a single line on purpose, all stated at their
own call sites or here:

- `render.ts`'s `stopped-by-owner` → `lastActivity.text`: the worker's
  own narration, not the cause of anything; the whole entry is in the
  transcript `fabrica log --transcript` prints.
- `src/foreman/queries.ts`'s `earlyFailureReason` → `fabrica status`'s
  task listing and the live view's review page, both one line per task by
  design.
- `src/foreman/delivery.ts`'s not-verified `summary`, `src/ci/report.ts`,
  `src/config/load.ts`, `src/brain/adapters/doctor-checks.ts`: all
  one-line summary or doctor lines.
- `render.ts`'s `delivered` and `ci-check-concluded` still omit the
  check's raw stdout/stderr and the CI log tail entirely. That is a
  decision about *which fields* to show (a receipt's output can run to
  64MB), not a truncation, and issue #169 does not touch it.

`fallbackDetail`'s 200-character cap was the only character-count
truncation of a message anywhere in `src/` — every other fixed `slice(0,
n)` in the tree shortens a commit sha or an id slug.
