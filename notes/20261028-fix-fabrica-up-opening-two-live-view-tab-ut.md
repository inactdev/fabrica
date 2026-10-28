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
restarted. `refreshStaleLiveView`'s `openBrowser` option therefore
defaults to "never open" rather than to the real opener, and
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
