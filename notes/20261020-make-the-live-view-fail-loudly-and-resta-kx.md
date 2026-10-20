# The live view fails loudly: a pinned startup commit, a staleness banner, and a loud projects.toml

## The bug this started from

`integrations/live-view/server.ts` called its `commit()` reader **per
request** on `/api/version`. For the one copy that matters - a developer
checkout - that reader is `runningCopyCommit(CHECKOUT)`, which shells out
to `git rev-parse HEAD` against the checkout on disk. So a live view
process started before a merge answered `/api/version` with the commit
the checkout is on *now*, not the commit whose code the process is
actually executing. Both callers of that endpoint
(`up-command.ts`'s `refreshStaleLiveView`, used by `fabrica up` and
`fabrica update`) compare it against their own
`runningCopyCommit(CHECKOUT)`, i.e. the same value - so the comparison
was a value against itself and could never report stale. The one thing
that check exists to catch - a live view left over from before the code
moved - was exactly the thing it could never catch.

The fix is one line of semantics: capture the commit **once**, at
`startLiveView` time, and answer `/api/version` from that captured
string forever. `/api/checkout` is the new endpoint that reads the
checkout fresh per request, so a page can tell the two apart.

## Design decision, and the alternative rejected

Safest-first ordering said: make the *comparison* trustworthy rather
than make the *restart* smarter.

**Rejected:** having `fabrica update` compare "the commit before the
pull" against "whatever `/api/version` reports" and restart on a
difference, leaving the endpoint re-reading the checkout. That is
fewer lines and no new endpoint. It was rejected because it leaves the
endpoint itself lying: anything else that ever asks a running live view
"what code are you running" - `fabrica up`, a page banner, a human with
curl - still gets the checkout's answer, not the process's. Fixing the
endpoint fixes every reader at once, which is also what let `fabrica
up`, `fabrica update` and the page banner all share one notion of
stale.

A second rejected shape: having the **server** decide staleness and send
the page a boolean. The Client's own ruling asked for two endpoints the
page compares itself (`/api/version` vs `/api/checkout`), which also
keeps `/api/version` a single-purpose fact rather than a judgment that
would have to be re-derived per request anyway.

## Where the banners live, and why there is a fourth script

`integrations/live-view/public/banner.js` is loaded by all four pages
(`index.html`, `history.html`, `task.html`, `review.html`) and owns the
whole banner strip. It is deliberately self-contained: it creates its own
DOM, polls its own two endpoints (`/api/checkout` each tick,
`/api/version` once - a process's startup commit cannot change while it
is answering), and needs no wiring in `app.js`/`task.js`/`review.js`.
The alternative - threading a `configError` field through every
page-state payload and teaching three separate renderers to draw it -
was rejected as three places to drift instead of one.

Its one-line staleness rule (stale only when both commits are known
strings and differ) is the same rule `up-command.ts`'s
`refreshStaleLiveView` applies, and the same rule
`integrations/live-view/display.ts`'s `stalenessNotice` is tested
against. That `.ts` copy is the tested one; `banner.js` mirrors it, the
same way `public/app.js` already mirrors `display.ts`'s `projectName`
and `src/cli/render.ts`'s `formatAge` - a plain script with no build
step cannot import across the `src/` boundary.

## A projects.toml that will not parse

`ConfigError` now carries an optional `line`, set only when the failure
is the TOML parse itself (`smol-toml`'s `TomlError` exposes `line` and
`column`; the field is read by duck-typing on a numeric `line`, not
`instanceof`, so a second copy of the package in a tree cannot silently
turn the line number off). The message was shortened to one line -
`<path>:<line>:<column>: not valid TOML - <reason>` - because all three
places that must now show it put it on a single line: `fabrica doctor`'s
FAIL line, `fabrica status`'s first line, and the live view's banner.
`smol-toml`'s own multi-line code block is dropped on purpose; the path
and the line are what a reader needs to go fix it.

`loadConfigOrProblem` (`src/config/load.ts`, re-exported from
`src/index.ts`) is the reader for everything that must **keep working**
with a broken file: it returns the defaults plus a `ConfigProblem`
(message, path, line). `loadConfig`/`src/cli/load-config.ts`'s
`loadConfigOrDefault` still throw, and must keep throwing - `fabrica
do`, `answer`, `verdict` and `run-task` all spend real money and must
refuse rather than silently run with no caps. The split is the point:
readers degrade loudly, spenders refuse.

The live view's record view (`record-view.ts`) used to rethrow a
malformed-config error straight out of `getState`, which turned the
whole page into one "could not read the record" line - a config problem
reported as a record problem, with the task list (which needs no config
at all) collateral damage. It now reads through `loadConfigOrProblem`,
so the list renders from the record and the banner carries the parse
error.

## `fabrica update` now starts a live view that was not running

Client ruling: when the commit changed, restart unconditionally - and if
none is running, start one; no opt-out flag.
`refreshStaleLiveView` gained `force` (skip the `/api/version`
comparison entirely and treat an already-listening live view as stale)
and `startIfStopped` (a new `"started"` outcome instead of
`"not-listening"`). `fabrica update` passes both exactly when
`before.commit !== after.commit`. `fabrica up` passes neither, so its
behavior is unchanged: it does its own "nothing listening" start, and
asks the version question when something is.

Two existing `update-command.test.ts` expectations were inverted by that
ruling and were rewritten rather than deleted: "no live view listening is
left alone" (now: a changed commit starts one) and "a live view already
running the new commit is left alone" (now: a changed commit restarts it
regardless of what it reports - the forced path). The
commit-did-not-change case keeps both old behaviors and has its own
test now.
