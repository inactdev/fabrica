# Only `fabrica up` opens a browser tab, and at most one per run

Durable fact worth keeping: there is exactly one browser-opening code
path in this repo - `src/cli/up-command.ts`'s `defaultOpenBrowser`,
reached only from `startLiveViewAndReport`, which has three call sites
(two inside `refreshStaleLiveView`, one in `runUpCommand`'s own
first-start branch). Nothing under `integrations/live-view/` ever opens
a browser; `integrations/live-view/start.ts` only binds and writes its
pid file.

## Where the second tab came from

Two commands in a row each opened their own tab. Both `fabrica up` and
`fabrica update` called `refreshStaleLiveView`, and that function
opened a browser on every live view it started or restarted, for
whichever command asked.

In the ordinary case (a dev checkout whose commit is readable) the
sequence `fabrica update` then `fabrica up --continue` totalled one tab,
because `up`'s `/api/version` comparison found the live view `update`
had just started to be current and opened nothing. But the comparison

```ts
remoteCommit !== null && ourCommit !== null && remoteCommit === ourCommit
```

is inconclusive - and therefore "stale" - whenever *either* side is
null. `runningCopyCommit` (src/cli/doctor-command.ts) returns null for
an installed copy with a missing or commit-less `build-info.json`, a
state `fabrica doctor` reports as a FAIL that deliberately does **not**
stop a session (UP_HELP step 2 says so). In that state the live view's
own `/api/version` is null too, so:

- `fabrica update` restarts the live view (inconclusive = stale) and
  opens tab 1;
- `fabrica up --continue` restarts it again, for the same inconclusive
  reason, and opens tab 2.

The staleness rule itself is deliberate (up-command.ts's own comment:
a live view that cannot name its commit cannot be trusted to be running
today's code) and was left exactly as it was. What changed is who may
open a tab.

## The rule now

`fabrica up` is the only command that ever opens a browser tab, at most
once per run, and only for a live view that run itself started or
restarted. `refreshStaleLiveView`'s ready-callback
(`onLiveViewReady`) therefore defaults to "never open" rather than to
the real opener, and
`fabrica update` passes none at all - it has no opener in scope to
pass, which is what keeps it from growing a tab again. `fabrica update`
runs mid-session, when the page is already open in a tab that
reconnects to the restarted server by itself, and it ends by telling
the Client to run `fabrica up --continue` anyway.

Consequence worth knowing: `fabrica update` run on a machine with no
live view at all starts one silently, and the `fabrica up --continue`
that follows finds it current and only prints its address. That is
"none when a live view on the current commit is already running",
ruled on 2026-10-28, not an oversight.

## What guards it, and why reading source is the only way

"At most one tab per sequence" is partly a fact about *who calls*
`refreshStaleLiveView`, not about what any one command does, and no
seam can observe a call that has nowhere to come from. Two source-reading
tripwires cover what the counting tests cannot, the same way
`inspector-stamp-workflow.test.ts` checks a fact with no code of its own:

- `update-command.test.ts` fails if `update-command.ts` so much as names
  a route to a tab - a ready-callback, a browser-opener option of its
  own, or a direct `open`/`xdg-open`/`start` spawn behind both their
  backs.
- `up-command.test.ts` pins the complete set of `refreshStaleLiveView`
  callers (every non-test `.ts` under `src/` and `integrations/`) to
  exactly `up-command.ts` and `update-command.ts`. The callback defaults
  to opening nothing, which is right for a caller that says nothing but
  also means a third caller would inherit "no tab" in silence; failing
  on its arrival is what makes that a decision rather than an accident.

The counting tests' own fixture models a live view the way a command
sees one from outside (a bound port plus the commit that process
captured at startup). Each fact it models is separately proven against
the real component - `integrations/live-view/server.test.ts` for
`/api/version` reporting the startup commit and for its null answer,
`doctor-command.test.ts` for `runningCopyCommit` - so the fixture is
checkable rather than taken on trust.
